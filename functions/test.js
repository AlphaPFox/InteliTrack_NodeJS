const admin = require("firebase-admin");
const node_geocoder = require("node-geocoder");
const geolocation = require("geolocation-360");
const moment = require("moment");

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

//Initialize geolocation service using two providers (google and openCellId)
geolocation.initialize({
	googleApiKey: 'AIzaSyBBw803hHB7msBTnZ53YHdDWFPcJACIyCc',
	openCellIdApiKey: '9d604982096e3a'
});

// Cloud function: Parse data received from a TCP server
firestore.collection("TCP_Received").doc('0Ocui4BSOzzs7rlsvifT').get().then(async docSnapshot => 
{
	// Get TCP message data
	const tcp_message = docSnapshot.data();

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
				console.debug('TCP Message (COBAN PROTOCOL) received from unknown tracker.', tcp_message);
			}
			// Check if default tracker location message
			else if(tcp_message.content.length > 10 && tcp_message.content[1] === 'tracker') 
			{
				// Get if GPS signal is fixed
				if(tcp_message.content[4] === 'F')
				{
					// Tracker not found, skip parsing
					console.debug(`Parsing TCP Message (COBAN PROTOCOL) received from tracker: ${tracker.data().name}`, tcp_message);

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
					return insert_coordinates(tracker, coordinate_params, tcp_message.content[1]);
				}
				else
				{
					//Initialize request params array
					const requestParams = 
					{
						mcc: '724',
						mnc: getMNC(tracker.data().network),
						lac: parseInt(tcp_message.content[7], 16),
						cid: parseInt(tcp_message.content[9], 16)
					};

					//Log data
					console.debug('Requesting geolocation from cell tower', requestParams);

					//will use requests available in order of api key provided
					geolocation.request(requestParams, (error, result) =>
					{  
						//If result is successfull
						if (result && result.latitude < 90 && result.longitude < 90) 
						{
							//Parse datetime (ex.: 181106115734)
							const datetime = moment(tcp_message.content[2], 'YYMMDDhhmmss').toDate();

							//Create coordinates object
							const coordinates = new admin.firestore.GeoPoint(result.latitude, result.longitude);

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
							return insert_coordinates(tracker, coordinate_params, tcp_message.content[1]);
						}
						else
						{
							//Log data
							console.error('Failed to geolocate GSM cell tower', error);

							//End method
							return null;
						}
					});
				}
			}
			else if(tcp_message.content[1] === 'connected')
			{
				//End method by sending notification to users subscribed on this topic
				return sendNotification(tracker.id, 'Notify_Available', {
					title: 'Conexão GPRS',
					content: 'Rastreador conectado',
					expanded: 'O rastreador se conectou ao servidor Intelitrack',
					datetime: Date.now().toString()
				});
			}
			else
			{
				//Warning
				console.error('Unknown TK102B data structure', tcp_message);
			}		
		} 
		catch (error)
		{
			//Error running async functions
			console.error('Error parsing message', error);
		}
	}
	else
	{
		// Log error
		console.error('Unable to parse message, unknown protocol type', tcp_message);
	}

	// Message parsed, delete from collection
	return firestore.collection('TCP_Received').doc(docSnapshot.id).delete();
});

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
		const new_coordinate = tracker.data().lastCoordinate === null || coordinate_params.datetime > tracker.data().lastCoordinate.datetime

		//Conditions to create a new coordinate entry no DB
		//1 - No previous coordinate
		//2 - Last coordinate was from GPS and now its from GSM
		//3 - Distance between last coordinate and current is greater than 5km for GSM or 50m for GPS
		if(previousCoordinate === null || previousCoordinate.data().type === 'GPS' && coordinate_params.type === 'GSM' || getDistance(coordinate_params.position, previousCoordinate.data().position) > (previousCoordinate.data().type === 'GSM' ? 5000 : 50))
		{
			//Log data
			console.debug(`New coordinate from tracker: ${tracker.data().name} - Requesting geocode`);

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
				console.warn('Error on reverse geocoding', error);
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
					await sendNotification('Notify_Move', 
					{
						title: (previousCoordinate === null ? 'Posição do rastreador disponível' : 'Notificação de movimentação'),
						content: (coordinate_params.type === 'GSM' ? '(Sinal de GPS fraco, localização aproximada)' : coordinate_params.address),
						coordinates: (coordinate_params.type === 'GSM' ? '(GSM)_' : `(GPS)_${coordinate_params.position.latitude},${coordinate_params.position.longitude}`),
						datetime: Date.now().toString()
					}, notification);
				}
			}
		}
		else
		{
			//Log data
			console.debug(`Updating previous coordinate from tracker: ${tracker.data().name}`);

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
				await sendNotification('Notify_Stopped', {
					title: 'Notificação de permanência',
					content: (coordinate_params.type === 'GSM' ? '(Sinal de GPS fraco, localização aproximada)' : 'Rastreador permanece na mesma posição.'),
					coordinates: (coordinate_params.type === 'GSM' ? '(GSM)_' : `(GPS)_${coordinate_params.position.latitude},${coordinate_params.position.longitude}`),
					datetime: Date.now().toString()
				}, notification);
			}
			
			//Log info
			console.info(`Successfully parsed location message from: ${tracker.data().name} - Coordinate updated`);
		}

		//If new coordinate
		if(new_coordinate)
		{
			//Update tracker last coordinate field
			return firestore
				.collection('Tracker')
				.doc(tracker.id)
				.set(
					{
						tracker_params: 
						{
							type: coordinate_params.type,
							location: coordinate_params.position,
							datetime: coordinate_params.datetime
						},
						lastUpdate: coordinate_params.datetime
					}, 
					{ merge: true })
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
	return admin.messaging().sendToTopic(topic, { data: params }, 
	{
		priority: 'high',
		timeToLive: 60 * 60 * 24,
		collapseKey: topic
	})
	.then(() => 
	{
		// Message sent successfully
		console.debug(`Successfully sent message to topic ${topic}`, params);
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