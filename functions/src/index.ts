import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as node_geocoder from 'node-geocoder';
import * as geolocation from 'bscoords';
import * as moment from 'moment';

//Initialize firebase admin service
admin.initializeApp();

//Initialize firestore service
const firestore = admin.firestore();

//Set firestore settings
firestore.settings({timestampsInSnapshots: true});

//Initialize geocoder service using google maps static api key
const geocoder = node_geocoder({
	provider: 'google',
	apiKey: 'AIzaSyAq8QebBfeR7sVRKErHhmysSk5U80Zn3xE', // for Mapquest, OpenCage, Google Premier
});

//Initialize geolocation API to get location from GSM Towers
geolocation.init({
	// API keys
	apikey_opencellid: '9d604982096e3a', 
	apikey_google: 'AIzaSyBBw803hHB7msBTnZ53YHdDWFPcJACIyCc',
	timeout: 2000 // socket timeout in milliseconds
});

// Cloud function: Parse data received from a TCP server
exports.parseTCP = functions.firestore.document('TCP_Inbox/{messageId}').onCreate(async docSnapshot => 
{
	// Get TCP message data
	const tcp_message = docSnapshot.data();

	// Tracker not found, skip parsing
	console.info('Function initialized, parsing TCP Message', tcp_message);

	// Check protocol
	if(tcp_message.type === 'COBAN_PROTOCOL')
	{
		try
		{
			// Try to find tracker associated with this tcp message
			const tracker = (await firestore.collection('Tracker').where('imei', '==', tcp_message.source).get()).docs[0];

			// Check if tracker retrieved
			if(!tracker)
			{
				// Tracker not found, skip parsing
				console.error('TCP Message (COBAN PROTOCOL) received from unknown tracker.', tcp_message);

				// Return error
				return firestore.collection('TCP_Inbox').doc(docSnapshot.id).set({parseResult: 'Unknown tracker'}, {merge: true});
			}
			// Check if default tracker location message
			else if(tcp_message.content.length > 10 && tcp_message.content[1] === 'tracker') 
			{
				// Get if GPS signal is fixed
				if(tcp_message.content[4] === 'F')
				{
					// Tracker not found, skip parsing
					console.info(`Parsing TCP Message (COBAN PROTOCOL) received from tracker: ${tracker.data().name}`, tcp_message);

					//Parse datetime (ex.: 181106115734)
					const datetime = moment.utc(tcp_message.content[2].substring(0, 6) + tcp_message.content[5].substring(0, 6), 'YYMMDDhhmmss').toDate();

					//Parse coordinate from degrees/minutes to a GeoPoint
					const coordinates = new admin.firestore.GeoPoint(parseCoordinate(tcp_message.content[7], tcp_message.content[8]), parseCoordinate(tcp_message.content[9], tcp_message.content[10]));
					
					//Parse speed
					const speed = tcp_message.content[11];
					
					//Define coordinates params to be inserted/updated
					const coordinate_params = 
					{
						type: 'GPS',
						signalLevel: 'N/D',
						batteryLevel: 'N/D',
						datetime: datetime,
						position: coordinates,
						speed: speed
					}

					//Insert coordinates on DB
					await insert_coordinates(tracker, coordinate_params, tcp_message.content[1]);
				}
				else
				{
					//Log data
					console.info('Requesting geolocation from cell tower');

					//Try to get position from nearest GSM cell tower
					try
					{
						//Use google service for geolocation
						const coords = await geolocation.google('724', getMNC(tracker.data().network), parseInt(tcp_message.content[7], 16), parseInt(tcp_message.content[9], 16));

						//Geolocation results
						console.info('Result', coords);

						//Parse datetime (ex.: 181106115734)
						const datetime = moment.utc(tcp_message.content[2], 'YYMMDDhhmmss').toDate();

						//Create coordinates object
						const coordinates = new admin.firestore.GeoPoint(coords.lat, coords.lon);

						//Define coordinates params to be inserted/updated
						const coordinate_params = 
						{
							type: 'GSM',
							speed: 'N/D',
							batteryLevel: tracker.data().batteryLevel,
							signalLevel: tracker.data().signalLevel,
							datetime: datetime,
							position: coordinates
						}
						
						//Insert coordinates on db with default notification
						await insert_coordinates(tracker, coordinate_params, tcp_message.content[1]);
					}
					catch(error)
					{
						//Log data
						console.error('Failed to geolocate GSM cell tower', error);

						// Return error
						return firestore.collection('TCP_Inbox').doc(docSnapshot.id).set({parseResult: 'Geolocation error', error: error}, {merge: true});
					}
				}
			}
			else if(tcp_message.content[1] === 'connected')
			{
				//End method by sending notification to users subscribed on this topic
				await sendNotification(tracker.id, 'Notify_Available', {
					title: 'Conexão GPRS',
					content: 'Rastreador conectado',
					expanded: 'O rastreador se conectou ao servidor Intelitrack',
					datetime: Date.now().toString()
				});
			}
			else
			{
				//Log error
				console.error('Unknown COBAN PROTOCOL data structure', tcp_message);

				// Return error
				return firestore.collection('TCP_Inbox').doc(docSnapshot.id).set({parseResult: 'Unknown COBAN PROTOCOL data structure'}, {merge: true});
			}		
		} 
		catch (error)
		{
			//Error running async functions
			console.error('Error parsing message', error);

			// Return error
			return firestore.collection('TCP_Inbox').doc(docSnapshot.id).set({parseResult: 'Error parsing message', error: error}, {merge: true});
		}
	}
	else if (tcp_message.type === 'DISCONNECT')
	{
		// Try to find tracker associated with this tcp message
		const tracker = (await firestore.collection('Tracker').where('imei', '==', tcp_message.source).get()).docs[0];

		// Check if tracker retrieved
		if(tracker)
		{
			//End method by sending notification to users subscribed on this topic
			await sendNotification(tracker.id, 'Notify_Available', {
				title: `Conexão finalizada`,
				content: `O rastreador se desconectou do servidor`,
				expanded: `A conexão com o servidor foi finalizada pelo dispositivo rastreador`,
				datetime: Date.now().toString()
			});
		}
	}
	else
	{
		// Log error
		console.error('Unable to parse message, unknown protocol type', tcp_message);

		// Return error
		return firestore.collection('TCP_Inbox').doc(docSnapshot.id).set({parseResult: 'Unknown protocol type'}, {merge: true});
	}

	// Message parsed, delete from collection
	return firestore.collection('TCP_Inbox').doc(docSnapshot.id).delete();
});

// Cloud function: Parse data received from a SMS server
exports.parseSMS = functions.firestore.document('SMS_Inbox/{messageId}').onCreate(async docSnapshot => 
{
	try
	{
		// Get TCP message data
		const sms_message = docSnapshot.data();

		//Log data
		console.info("Parsing SMS received", sms_message);

		// Check if message is a delivery report
		if(sms_message.reference)
		{
			//Search for the most recent SMS with this reference
			const query = await firestore
				.collection(`SMS_Sent`)
				.where(`reference`, `==`, sms_message.reference.toString())
				.orderBy(`sent_time`, `desc`)
				.limit(1)
				.get()

			//If SMS found
			if(!query.empty)
			{
				//Get sms_sent reference
				const sms_sent = query.docs[0];
				
				//Update sms document
				await sms_sent.ref.set(
				{
					delivery_status: sms_message.status,
					received_time: admin.firestore.FieldValue.serverTimestamp()
				}, {merge: true});

				//Check delivery report status
				if(sms_message.status === 0)
				{
					//Log data
					console.info("Successfull delivery report parsed");

					//Update configuration data
					return firestore.doc(sms_sent.data().configuration).update(
					{ 
						"status.step": "RECEIVED",
						"status.description": "Configuração recebida pelo rastreador",
						"status.datetime": admin.firestore.FieldValue.serverTimestamp()
					});
				}
				else
				{
					//Log data
					console.info("Failed delivery report parsed");

					//Update configuration data
					return firestore.doc(sms_sent.data().configuration).update(
					{ 
						"status.step": "ERROR",
						"status.description": "Configuração não recebida pelo rastreador",
						"status.datetime": admin.firestore.FieldValue.serverTimestamp()
					});
				}
			}
			else
			{
				//SMS not found error
				throw {error: `SMS with reference supplied not found`, sms: sms_message};
			}
		}
		else
		{
			//Log data
			console.info("Parsing SMS text message", sms_message.text);

			//Remove null bytes from string
			const sms_text = sms_message.text.replace(/\0/g, "");
			

				

			//Remove SMS from inbox folder
			return null;
		}
	} 
	catch(error)
	{
		//Log error
		console.error(`Error parsing SMS from inbox`, error);

		//End method
		return null;
	}
	
});

// Cloud function: Parse data received from a TCP server
exports.buildConfiguration = functions.firestore.document('Tracker/{trackerId}/Configurations/{configurationId}').onWrite(async (docSnapshot, context) => 
{
	try
	{
		//New configuration, build command
		let command;

		//Get tracker data
		const tracker = (await firestore.doc(`Tracker/${context.params.trackerId}`).get());

		//Check if document not deleted
		if(docSnapshot.after.exists)
		{
			//Get configuration data
			const configuration = docSnapshot.after.data();

			//Get tracker password
			const tracker_password = tracker.data().password;

			//Check configuration status
			if(configuration.status.step === "REQUESTED")
			{
				//Check configuration name
				switch(configuration.name)
				{
					case `Begin`:
						//GENERAL CONFIG: Initialize tracker
						command = `begin${tracker_password}`;
						break;

					case `TimeZone`:
						//GENERAL CONFIG: Set timezone to 0
						command = `time zone${tracker_password} 0`
						break;

					case `StatusCheck`:
						//GENERAL CONFIG: Request tracker status	
						command = `check${tracker_password}`;
						break;

					case `IMEI`:
						//GENERAL CONFIG: Request tracker IMEI
						command = `imei${tracker_password}`;
						break;

					case `Reset`:  
						//GENERAL CONFIG: Request tracker to reset
						command = `reset${tracker_password}`;
						break;

					case `AccessPoint`:
						//COMMUNICATION CONFIG: Set APN
						command = `apn${tracker_password} ${configuration.value}`;
						break;

					case `APNUserPass`:
						//COMMUNICATION CONFIG: Set APN user password
						command = `up${tracker_password} ${configuration.value}`;
						break;

					case `AdminIP`:
						//COMMUNICATION CONFIG: Set server IP
						command = `adminip${tracker_password} ${configuration.value ? configuration.value : `187.4.165.10 5001`}`;
						break;
						
					case `GPRS`:
						//COMMUNICATION CONFIG: Enable GPRS mode
						command = `gprs${tracker_password}`;
						break;
						
					case `LessGPRS`:
						//COMMUNICATION CONFIG: Reduced GPRS mode
						command = `less gprs${tracker_password} ${configuration.enabled ? `on` : `off` }`;
						break;
						
					case `SMS`:
						//COMMUNICATION CONFIG: Enable SMS mode
						command = `sms${tracker_password}`;
						break;
						
					case `Admin`:
						//COMMUNICATION CONFIG: Set SMS administrator phone number
						command = `${configuration.enabled ? `` : `no`}admin${tracker_password} ${configuration.value ? configuration.value : `67998035423`}`;
						break;
						
					case `PeriodicUpdate`:
						//OPERATION CONFIG: Set position update interval
						command = configuration.enabled ? `${configuration.value}${tracker_password}` : `nofix${tracker_password}`;
						break;

					case `Sleep`:
						//OPERATION CONFIG: Set sleep mode
						command = configuration.enabled ? `sleep${tracker_password} ${configuration.value}` : `sleep${tracker_password} off`;
						break;

					case `Schedule`:
						//Send SMS to configure shock alert
						command = configuration.enabled ? `schedule${tracker_password} ${configuration.value}` : `noschedule${tracker_password}`;
						break;

					case `Move`:
						//Move out alert
						command = configuration.enabled ? `move${tracker_password} ${configuration.value}`: `nomove${tracker_password}`;
						break;
						
					case `Speed`:
						//Speed limit alert
						command = configuration.enabled ? `speed${tracker_password} ${configuration.value}` : `nospeed${tracker_password}`;
						break;

					case `Shock`:
						//Send SMS to configure shock alert
						command = configuration.enabled ? `shock${tracker_password}`: `noshock${tracker_password}`;
						break;

					default:
						//Config unknown, send default
						command = configuration.name + ` ` + configuration.value;
						break;
				}

				//Log data
				console.info(`Scheduling SMS command [${configuration.name} -> '${command}] to tracker ${tracker.data().name}`);

				//Create SMS to be sent by the server
				const sms_reference = await firestore
					.collection('SMS_Outbox')
					.add(
					{
						command: command,
						to: tracker.data().identification,
						path: docSnapshot.after.ref.path,
						datetime: admin.firestore.FieldValue.serverTimestamp()
					})

				//Set configuration status
				configuration.status = 
				{
					step: "SCHEDULED",
					command: command,
					description: "Aguardando para ser enviado ao rastreador",
					datetime: admin.firestore.FieldValue.serverTimestamp(),
					sms_reference: sms_reference.path,
					finished: false
				};
				
				//Log data
				console.info(`Configuration ${configuration.name} parsed successfully.`, configuration);	

				//Finish method and update configuration
				return docSnapshot.after.ref.update(configuration);
			}
			else if(configuration.status.step !== "SCHEDULED")
			{
				//Update TRACKER PARAMS
				return updateConfiguration(tracker, configuration);
			}
		}
		
		//End method, no updates required
		return null;
	}
	catch(error)
	{
		//Log data
		console.error('Error on tracker configuration', error);

		//End method
		return null;
	}
});

// Update configuration progress 
async function updateConfiguration(tracker: FirebaseFirestore.DocumentSnapshot, configuration: FirebaseFirestore.DocumentData) : Promise<FirebaseFirestore.WriteResult>
{
	try
	{
		//Get all pending configurations from this tracker
		const configurations = await firestore
			.collection(`Tracker/${tracker.id}/Configurations`)
			.where(`status.finished`, `==`, false)
			.get();
			
		//Try to get current tracker configuration progress
		let configProgress = tracker.data().lastConfiguration;

		//If configuration not initialized yet
		if(!configProgress)
		{
			//Create a new configuration for this tracker
			configProgress = 
			{
				datetime: admin.firestore.FieldValue.serverTimestamp(),
				pending: configurations.docs.length
			}
		}

		//Get current pending count
		let currentPending = configurations.docs.length;

		//For each pending configuration
		configurations.forEach(config => {

			//Get current config status and update progress
			switch(config.data().status.step)
			{
				case 'SCHEDULED':
					currentPending -= 0.1;
					break;
				case 'SENT':
					currentPending -= 0.3;
					break;
				case 'RECEIVED':
					currentPending -= 0.6;
					break;
				case 'CONFIRMED':
					currentPending -= 1;
					break;
			}
		})

		//Log data
		console.info(`Updating configuration ${configuration.name} on tracker ${tracker.id}: Status: ${configuration.status.step}`);

		//Update current configuration description
		configProgress.description = configuration.description;
		configProgress.status = configuration.status.description;
		configProgress.datetime = configuration.status.datetime;
				
		//Calculate configuration progress
		configProgress.progress = Math.ceil((configProgress.pending - currentPending )* 100 / configProgress.pending);

		//Return update on tracker
		return tracker.ref.set({lastConfiguration: configProgress}, {merge: true});
	}
	catch(error)
	{
		//Log error
		console.log(`Error updating tracker ${tracker.data().name} configuration progress`);

		//End method
		return null;
	}
}

// Parse degree coordinate value (format: '2304.56556', 'S'), return as decimal -23.4204
function parseCoordinate(value, orientation)
{
	//Get degrees and minutes from value
	const degrees = parseInt(value.substring(0, value.indexOf('.') - 2));
	const minutes = parseFloat(value.substring(value.indexOf('.') - 2));

	// Convert to decimal
	let decimal = degrees + minutes / 60;

	// Check orientation
	if(orientation === 'S' || orientation === 'W')
	{
		// Negative for south or west
		decimal = decimal * -1;
	}

	return decimal;
}

// Calculate the distance between to GeoPoints
function getDistance(coordinates1, coordinates2) 
{
	// Math.PI / 180
	const p = 0.017453292519943295;

	// Calculate distance
	const a = 0.5 - 
				Math.cos((coordinates2.latitude - coordinates1.latitude) * p)/2 + 
				Math.cos(coordinates1.latitude * p) * Math.cos(coordinates2.latitude * p) * 
				(1 - Math.cos((coordinates2.longitude - coordinates1.longitude) * p))/2;

	// 2 * R; R = 6371 km
	return 12742000 * Math.asin(Math.sqrt(a)); 
}

// Insert parsed coordinates to corresponding tracker collection
async function insert_coordinates(tracker, coordinate_params, notification)
{
	try
	{
		// Try to get the last coordinate before the current coordinate datetime
		const querySnapshot = await firestore
			.collection('Tracker/' + tracker.id + '/Coordinates')
			.where('datetime', '<=', coordinate_params.datetime)
			.orderBy('datetime', 'desc')
			.limit(1)
			.get();

		//Get result from query
		const previousCoordinate = querySnapshot.docs[0];

		// Check if this is the latest coordinate from this tracker
		const new_coordinate = querySnapshot.empty || coordinate_params.datetime > tracker.data().lastCoordinate.datetime.toDate()
	
		//Conditions to create a new coordinate entry no DB
		//1 - No previous coordinate
		//2 - Last coordinate was from GPS and now its from GSM
		//3 - Distance between last coordinate and current is greater than 5km for GSM or 50m for GPS
		if(querySnapshot.empty || previousCoordinate.data().type === 'GPS' && coordinate_params.type === 'GSM' || getDistance(coordinate_params.position, previousCoordinate.data().position) > (previousCoordinate.data().type === 'GSM' ? 5000 : 50))
		{
			//Log data
			console.info(`New coordinate from tracker: ${tracker.data().name} - Requesting geocode`);

			//Try to geocode data
			try
			{
				//Request reverse geocoding
				const result = await geocoder.reverse({lat: coordinate_params.position.latitude, lon: coordinate_params.position.longitude});
				
				//Save geocoding result (textual address)
				if(coordinate_params.type === 'GSM')
				{
					//Weak GPS signal, get only city name
					coordinate_params.address = `${result[0].administrativeLevels.level2long}/${result[0].administrativeLevels.level1short} - Sinal GPS fraco, localização aproximada.`;
				}
				else
				{
					//Strong GPS signal, get full textual address
					coordinate_params.address = result[0].formattedAddress;
				}
			}
			catch(error)
			{
				//Error geocoding address
				coordinate_params.address = 'Endereço próximo à coordenada não disponível.';
								
				//Log data
				console.error('Error on reverse geocoding', error);
			}
			finally
			{
				//Insert coordinates with geocoded address
				await firestore
					.collection('Tracker/' + tracker.id + '/Coordinates')
					.doc()
					.set(coordinate_params)

				//Log info
				console.info(`Successfully parsed location message from: ${tracker.data().name} - Coordinate inserted`);

				//If this is a new coordinate
				if(new_coordinate)
				{
					//Sending notification to users subscribed on this topic
					await sendNotification(tracker.id, 'Notify_Move', 
					{
						title: (previousCoordinate === null ? 'Posição do rastreador disponível' : 'Notificação de movimentação'),
						content: (coordinate_params.type === 'GSM' ? '(Sinal de GPS fraco, localização aproximada)' : coordinate_params.address),
						coordinates: (coordinate_params.type === 'GSM' ? '(GSM)_' : `(GPS)_${coordinate_params.position.latitude},${coordinate_params.position.longitude}`),
						datetime: Date.now().toString()
					});
				}
			}
		}
		else
		{
			//Log data
			console.info(`Updating previous coordinate from tracker: ${tracker.id}`);

			//Save current date time (updating last coordinate)
			coordinate_params.lastDatetime = coordinate_params.datetime;

			//Remove datetime from params to preserve initial coordinate datetime
			delete coordinate_params.datetime;

			//If last coordinate was from GSM and now is from GPS
			if(previousCoordinate.data().type === 'GSM' && coordinate_params.type === 'GPS')
			{
				//Update text
				coordinate_params.address = 'Sinal de GPS recuperado, localização do rastreador definida no mapa.';
			}

			//Current coordinates is too close from previous, just update last coordinate
			await firestore
				.collection('Tracker/' + tracker.id + '/Coordinates')
				.doc(previousCoordinate.id)
				.update(coordinate_params);

			//If this is a new coordinateas
			if(new_coordinate)
			{
				//Send notification to users subscribed on this topic
				await sendNotification(tracker.id, 'Notify_Stopped', {
					title: 'Notificação de permanência',
					content: (coordinate_params.type === 'GSM' ? '(Sinal de GPS fraco, localização aproximada)' : 'Rastreador permanece na mesma posição.'),
					coordinates: (coordinate_params.type === 'GSM' ? '(GSM)_' : `(GPS)_${coordinate_params.position.latitude},${coordinate_params.position.longitude}`),
					datetime: Date.now().toString()
				});

				//Append datetime to update tracker params
			}
			
			//Log info
			console.info(`Successfully parsed location message from: ${tracker.data().name} - Coordinate updated`);
		}

		//If new coordinate
		if(new_coordinate)
		{
			//Get updated datetime from coordinate params
			const datetime = coordinate_params.datetime || coordinate_params.lastDatetime;

			//Update tracker last coordinate field
			await firestore
				.collection('Tracker')
				.doc(tracker.id)
				.set(
				{
					lastCoordinate: 
					{
						type: coordinate_params.type,
						location: coordinate_params.position,
						datetime: datetime
					},
					lastUpdate: datetime
				}, 
				{ merge: true })
				.then(() =>
				{
					//Log error
					console.info('Updated lastCoordinate from Tracker on DB');
				})
				.catch((error) =>
				{
					//Log error
					console.error('Error updating tracker on DB', error);
				});
		}
	} 
	catch (error)
	{
		//Log error
		console.error('Error parsing TCP Message', error);
	}	
}

// Send Firebase Cloud Message to a specific topic
async function sendNotification(tracker_id, channel, params)
{
	// Save tracker ID on param data
	params.id = tracker_id;

	// Save notification channel
	params.channel = channel;

	// Update topic structure to include trackerID
	const topic = tracker_id + '_' + channel;

   // Send a message to devices subscribed to the provided topic.
	await admin.messaging().sendToTopic(topic, { data: params }, 
	{
		priority: 'high',
		timeToLive: 60 * 60 * 24,
		collapseKey: topic
	})
	.then(() => 
	{
		// Message sent successfully
		console.info(`Successfully sent message to topic ${topic}`, params);
	})
	.catch((error) =>
	{
		// Error sending message
		console.error(`Error sending message to topic ${topic}`, error);
	});
}
	 
function getMNC(network)
{
	switch(network)
	{
		case 'TIM':
			return '04';
		case 'VIVO':
			return '06';
		case 'OI':
			return '16';
		case 'CLARO':
			return '05';
		default:
			return '02';
	}
}