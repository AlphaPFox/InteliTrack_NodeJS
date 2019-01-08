import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as node_geocoder from 'node-geocoder';
import * as geolocation from 'bscoords';
import * as nexmo_api from 'nexmo';
import * as moment from 'moment';
import * as util from 'util';

//Initialize firebase admin service
admin.initializeApp();

//Initialize firestore service
const firestore = admin.firestore();

//Set firestore settings
firestore.settings({timestampsInSnapshots: true});

//Initialize geocoder service using google maps static api key
const geocoder = node_geocoder({
	provider: 'google',
	apiKey: '', // for Mapquest, OpenCage, Google Premier
});

//Initialize geolocation API to get location from GSM Towers
geolocation.init({
	// API keys
	apikey_opencellid: '', 
	apikey_google: '',
	timeout: 2000 // socket timeout in milliseconds
});

//Initialize Nexmo API
const nexmo = new nexmo_api({
	apiKey: '',
	apiSecret: ''
 });

//Define sendSMS function 
const sendSMS = util.promisify(nexmo.message.sendSms.bind(nexmo.message));

// HTTP Cloud function: Parse SMS received, called by NEXMO api
exports.smsReceived = functions.https.onRequest(async (req, res) => {

	// Allow only POST requests.
	if (req.method !== 'POST') 
	{
		//End method with error code
		return res.status(403).send('Forbidden!');
	}

	//Log received SMS
	console.log('Received SMS data', req.body);

	try
	{
		//Check http post request format
		if(req.body.text && req.body.msisdn && req.body.msisdn.length < 20)
		{
			//Search for tracker with the same phone number
			const query = await firestore
				.collection(`Tracker`)
				.where(`phoneNumber`, `==`, req.body.msisdn.replace('55', ''))
				.get()

			//If tracker found
			if(!query.empty)
			{
				//Get tracker reference
				const tracker = query.docs[0];

				//Remove null bytes from string
				const sms_text = req.body.text.replace(/\0/g, ``).toLowerCase().trim();

				//Check tracker model
				if(tracker.data().model.startsWith('tk'))
				{
					//Parse TK (Coban) model SMS message
					await parseCobanSMS(tracker, sms_text);
					
					//End method
					return res.status(200).send('ok');
				}
				else
				{
					//Model unknown error
					throw new Error(`Tracker model not supported yet`);
				}
			}
			else
			{
				//Tracker not found error
				throw new Error(`Tracker with this phone number not found`);
			}
		}
		else
		{
			// Log error
			throw new Error(`Invalid HTTP request format`);
		}
	}
	catch(error)
	{
		// Log error
		console.error(`Unable to parse message: ${error.message}`);

		// End method
		return res.status(200).send('error parsing');
	}
});

// HTTP Cloud function: Parse SMS delivery report, called by NEXMO api
exports.deliveryReport = functions.https.onRequest(async (req, res) => {

	// Allow only POST requests.
	if (req.method !== 'POST') 
	{
		//End method with error code
		return res.status(403).send('Forbidden!');
	}

	//Log delivery report data
	console.log('Received SMS delivery report', req.body);
	
	try
	{
		//Check http post request format
		if(req.body.msisdn &&  req.body.messageId && req.body.messageId.length < 20)
		{
			//Search for the most recent SMS with this reference
			const query = await firestore
				.collection(`SMS_Sent`)
				.where(`messageId`, `==`, req.body.messageId)
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
					delivery_status: req.body.status,
					received_time: admin.firestore.FieldValue.serverTimestamp()
				}, {merge: true});

				//Get configuration related to this message
				const configuration = await firestore.doc(sms_sent.data().configuration).get()

				//If configuration not confirmed yet
				if(configuration.exists && configuration.data().status.step !== 'SUCCESS')
				{
					//Check delivery report status
					if(req.body.status === 'delivered')
					{
						//Log data
						console.info(`Delivery report parsed - Configuration delivered`, configuration.data());

						//Update configuration data
						await configuration.ref.update(
						{ 
							'status.step': `RECEIVED`,
							'status.description': `Configuração recebida pelo rastreador`,
							'status.datetime': admin.firestore.FieldValue.serverTimestamp()
						});
					}
					else
					{
						//Log data
						console.info(`Delivery report parsed - Configuration not delivered`, configuration.data());

						//Update configuration data
						await configuration.ref.update(
						{ 
							'status.step': `ERROR`,
							'status.description': `Configuração não recebida pelo rastreador`,
							'status.datetime': admin.firestore.FieldValue.serverTimestamp()
						});
					}
				}
				else
				{
					//Log data
					console.info(`Received delivery report from a confirmed configuration`, configuration);
				}
				
				//End method
				return res.status(200).send('ok');
			}
			else
			{
				//SMS not found error
				throw new Error(`Delivery report from unknown sent SMS`);
			}
		}
		else
		{
			// Log error
			throw new Error(`Invalid HTTP request format`);
		}
	}
	catch(error)
	{
		// Log error
		console.error(`Unable to parse delivery report: ${error.message}`);

		// End method
		return res.status(200).send('error parsing');
	}
 });

//Firestore cloud function: Parse data received from a TCP server
exports.parseTCP = functions.firestore.document('TCP_Inbox/{messageId}').onCreate(async snapshot => 
{
	// Get TCP message data
	const tcp_message = snapshot.data();

	// Log message strucutre
	console.info('Parsing TCP Message', tcp_message);

	try
	{
		// Try to find tracker associated with this tcp message source
		const tracker = (await firestore.collection('Tracker').doc(tcp_message.source).get());

		// Check if tracker retrieved
		if(tracker.exists)
		{
			// Check message type
			if(tcp_message.type === 'CONNECTED')
			{
				//Send notification to users subscribed on this topic
				await sendNotification(tracker.id, 'Notify_Available', {
					title: 'Conexão GPRS',
					content: 'Rastreador conectado',
					expanded: 'O rastreador se conectou ao servidor Intelitrack',
					datetime: Date.now().toString()
				});

				//Message parsed successfully, remove from TCP_Inbox
				return snapshot.ref.delete();
			}
			else if (tcp_message.type === 'DISCONNECTED')
			{
				//Send notification to users subscribed on this topic
				await sendNotification(tracker.id, 'Notify_Available', {
					title: `Conexão finalizada`,
					content: `O rastreador se desconectou do servidor`,
					expanded: `A conexão com o servidor foi finalizada pelo dispositivo rastreador`,
					datetime: Date.now().toString()
				});

				//Message parsed successfully, remove from TCP_Inbox
				return snapshot.ref.delete();
			}
			else if(tcp_message.type === 'COBAN_PROTOCOL')
			{
				//Try to parse COBAN PROTOCOL message
				await parseCobanProtocol(tracker, tcp_message);

				//Message parsed successfully, remove from TCP_Inbox
				return snapshot.ref.delete();
			}
			else if(tcp_message.type === 'TK103_PROTOCOL')
			{
				//Try to parse COBAN PROTOCOL message
				await parseTK103Protocol(tracker, tcp_message);

				//Message parsed successfully, remove from TCP_Inbox
				return snapshot.ref.delete();
			}
			else
			{
				// Protocol not found
				throw new Error(`Unknown message protocol from tracker ${tracker.data().name}`);
			}
		}
		else
		{
			// Tracker not found, skip parsing
			throw new Error(`TCP Message received from unknown source ${tcp_message.source}`);
		}
	} 
	catch(error)
	{
		// Log error
		console.error(`Unable to parse message: ${error.message}`);

		// Return error
		return snapshot.ref.set({parseResult: error.message}, {merge: true});
	}
});

// Cloud function: Parse data received from a SMS server
exports.parseSMS = functions.firestore.document('SMS_Inbox/{messageId}').onCreate(async docSnapshot => 
{
	try
	{
		// Get TCP message data
		const sms_message = docSnapshot.data();

		//Log data
		console.info(`Parsing SMS received`, sms_message);

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

				//Get configuration related to this message
				const configuration = await firestore.doc(sms_sent.data().configuration).get()

				//If configuration not confirmed yet
				if(configuration.exists && configuration.data().status.step !== 'SUCCESS')
				{
					//Check delivery report status
					if(sms_message.status === 0)
					{
						//Log data
						console.info(`Delivery report parsed - Configuration delivered`, configuration.data());

						//Update configuration data
						return configuration.ref.update(
						{ 
							'status.step': `RECEIVED`,
							'status.description': `Configuração recebida pelo rastreador`,
							'status.datetime': admin.firestore.FieldValue.serverTimestamp()
						});
					}
					else
					{
						//Log data
						console.info(`Delivery report parsed - Configuration not delivered`, configuration.data());

						//Update configuration data
						return configuration.ref.update(
						{ 
							'status.step': `ERROR`,
							'status.description': `Configuração não recebida pelo rastreador`,
							'status.datetime': admin.firestore.FieldValue.serverTimestamp()
						});
					}
				}
				else
				{
					//Log data
					console.info(`Received delivery report from a confirmed configuration`, configuration);

					//End method
					return null;
				}
			}
         else if(sms_message.client)
         {
            //Log data
				console.info(`Received delivery report from client testing - Auth:  ${sms_message.client}`);
				
            //End method
            return null;
			}
			else
			{
				//SMS not found error
				throw new Error(`SMS with reference supplied not found`);
			}
		}
		else
		{
			//Search for tracker with the same phone number
			const query = await firestore
				.collection(`Tracker`)
				.where(`phoneNumber`, `==`, sms_message.sender)
				.get()

			//If tracker found
			if(!query.empty)
			{
            //Get tracker reference
            const tracker = query.docs[0];

            //Remove null bytes from string
            const sms_text = sms_message.text.replace(/\0/g, ``).toLowerCase().trim();
				
				//Check tracker model
				if(tracker.data().model.startsWith('tk'))
				{
					//Parse TK (Coban) model SMS message
					await parseCobanSMS(tracker, sms_text);
					
					//End method
					return null;
				}
				else
				{
					//Model unknown error
					throw new Error(`Tracker model not supported yet`);
				}
         }
         else if(sms_message.client)
         {
            //Log data
				console.info(`Received SMS from client testing - Auth:  ${sms_message.client}`);

            //End method
            return null;
			}
			else
         {
            //Tracker not found error
				throw new Error(`Tracker with this phone number not found`);
         }
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

		//Get configuration data
		const configuration = docSnapshot.after.data();

		//Check if document not deleted
		if(docSnapshot.after.exists)
		{
			//Get tracker password
			const tracker_password = tracker.data().password;

			//Check configuration status
			if(configuration.status.step === `REQUESTED`)
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
						
					case `Timer`:
						//OPERATION CONFIG: Set position update interval (TK103 model)
						command = configuration.enabled ? `${configuration.value}${tracker_password}` : `notn${tracker_password}`;
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

				//Check if phone number is available to send configuration
				if(tracker.data().phoneNumber.replace(/\D/g,'').length === 11)
				{
					try 
					{
						//Log data
						console.info(`Sending SMS [${configuration.name} -> '${command}] to tracker ${tracker.data().name} using Nexmo API`);

						//Try to send SMS using Nexmo API
						const result = await sendSMS('5511953259255', `55${tracker.data().phoneNumber}`, command);

						//Log data
						console.info(`Result: `, result);
					
						//Check status
						if(result.messages[0].status === '0')
						{
							//Save SMS on Sent collection
							const sms_reference = await firestore.collection('SMS_Sent').add(
							{
								server: 'Nexmo API',
								messageId: result.messages[0]['message-id'],
								text: command,
								configuration: docSnapshot.after.ref.path,
								sent_time: admin.firestore.FieldValue.serverTimestamp(),
								status: `SENT`
							});

							//Set configuration SENT status
							configuration.status = 
							{
								step: `SENT`,
								description: `Configuração enviada ao servidor`,
								command: command,
								datetime: admin.firestore.FieldValue.serverTimestamp(),
								sms_reference: sms_reference.path,
								finished: false
							};
							
							//Log data
							console.info(`SMS successfuly sent, stored at ${sms_reference.path}`);
						}
						else
						{
							//Error sending SMS
							throw new Error(`Status: ${result.messages[0].status} / Message: ${result.messages[0]['error-text']}`);
						}
					} 
					catch (error) 
					{
						// Log error
						console.error(`Unable to sent using Nexmo API: ${error.message}, storing on SMS_Outbox collection`);
						
						//Create SMS to be sent by the server
						const sms_reference = await firestore
							.collection('SMS_Outbox')
							.add(
							{
								command: command,
								to: tracker.data().phoneNumber,
								path: docSnapshot.after.ref.path,
								datetime: admin.firestore.FieldValue.serverTimestamp()
							})

						//Set configuration scheduled status
						configuration.status = 
						{
							step: `SCHEDULED`,
							description: `Aguardando para ser enviado ao rastreador`,
							command: command,
							datetime: admin.firestore.FieldValue.serverTimestamp(),
							sms_reference: sms_reference.path,
							finished: false
						};
					}
				}
				else
				{
					//Log data
					console.info(`SMS command [${configuration.name} -> '${command}] to tracker ${tracker.data().name} not scheduled - No phone number available`);

					//Set configuration error status
					configuration.status = 
					{
						step: `ERROR`,
						description: `Número de telefone inválido`,
						command: command,
						datetime: admin.firestore.FieldValue.serverTimestamp(),
						finished: true
					};
				}
								
				//Log data
				console.info(`Configuration ${configuration.name} parsed successfully.`, configuration);	

				//Finish method and update configuration
				return docSnapshot.after.ref.update(configuration);
			}
			else if(docSnapshot.before.exists)
			{
				//if configuration was SCHEDULED before and now is now CONFIRMED OR CANCELED
				if(docSnapshot.before.data().status.step === `SCHEDULED` && (configuration.status.step === `CONFIRMED` || configuration.status.step === `CANCELED`))
				{
					//Remove SMS from outbox collection
					await firestore.doc(configuration.status.sms_reference).delete();	
				}
				
				//if configuration is no longer scheduled
				if(configuration.status.step !== `SCHEDULED`)
				{
					//Update configuration proggress
					return updateConfiguration(tracker, configuration);
				}
			}
		}
		else if(configuration.status.step === `SCHEDULED`)
		{
			//Configuration deleted - remove SMS from outbox collection
			return firestore.doc(configuration.status.sms_reference).delete();		
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

async function parseCobanSMS(tracker, sms_text)
{
	//Check if text is response from a configuration
	if(sms_text.startsWith(`begin `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `Begin`, true, sms_text);
	}
	else if(sms_text.startsWith(`time `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `TimeZone`, true, sms_text);
	}
	else if(!isNaN(sms_text))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `IMEI`, true, sms_text);
	}
	else if(sms_text.startsWith(`reset `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `Reset`, true, sms_text);
	}
	else if(sms_text.startsWith(`apn `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `AccessPoint`, true, sms_text);
	}
	else if(sms_text.startsWith(`user`))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `APNUserPass`, true, sms_text);
	}
	else if(sms_text.startsWith(`adminip `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `AdminIP`, true, sms_text);
	}
	else if(sms_text.startsWith(`gprs `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `GPRS`, true, sms_text);
	}
	else if(sms_text.startsWith(`less gprs on `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `LessGPRS`, true, sms_text);
	}
	else if(sms_text.startsWith(`less gprs off `))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `LessGPRS`, false, sms_text);
	}
	else if(sms_text.startsWith(`sms `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `SMS`, true, sms_text);
	}
	else if(sms_text.startsWith(`admin `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `Admin`, true, sms_text);
	}
	else if(sms_text.startsWith(`noadmin `))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `Admin`, false, "ok");
	}
	else if(sms_text.includes(`phone number is not`))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `Admin`, false, `ok`);
	}
	else if(sms_text.startsWith(`sleep off`))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `Sleep`, false, sms_text);
	}
	else if(sms_text.startsWith(`sleep `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `Sleep`, true, sms_text);
	}
	else if(sms_text.startsWith(`noschework `))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `Schedule`, false, sms_text);
	}
	else if(sms_text.startsWith(`schework `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `Schedule`, true, sms_text);
	}
	else if(sms_text.startsWith(`nofix`))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `PeriodicUpdate`, false, sms_text);
	}
	else if(sms_text.startsWith(`t0`))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `Timer`, true, sms_text);
	}
	else if(sms_text.startsWith(`notn`))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `Timer`, false, sms_text);
	}
	else if(sms_text.startsWith(`noshock `))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker,`Shock`, false, sms_text);
	}
	else if(sms_text.startsWith(`shock `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker,`Shock`, true, sms_text);
	}
	else if(sms_text.startsWith(`nomove `))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `Move`, false, sms_text);
	}
	else if(sms_text.startsWith(`move `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `Move`, true, sms_text);
	}
	else if(sms_text.startsWith(`nospeed `))
	{
		//Confirm configuration disabled
		await confirmConfiguration(tracker, `Speed`, false, sms_text);
	}
	else if(sms_text.startsWith(`speed `))
	{
		//Confirm configuration enabled
		await confirmConfiguration(tracker, `Speed`, true, sms_text);
	}
	else if(sms_text.includes(`password err`))
	{
		//Confirm configuration ERROR
		await confirmConfiguration(tracker, `Begin`, true, sms_text);
	}
	else if(sms_text.includes(`help me! ok!`))
	{
		//Confirm configuration enabled
		console.info(`Successfully disabled SOS alert from: ${tracker.data().name}`);
	}
	else if(sms_text.includes(`low battery! ok!`))
	{
		//Confirm configuration enabled
		console.info(`Successfully disabled low battery alert from: ${tracker.data().name}`); 
	}
	else if(sms_text.startsWith(`bat: `) || sms_text.startsWith(`gsm: `))
	{
		//Status check configuration successfully applied
		await confirmConfiguration(tracker, `StatusCheck`, true, sms_text);
		
		//Log info
		console.info(`Successfully parsed status message from: ${tracker.data().name}`);
	}
	else if(sms_text.indexOf("cid:") >= 0)
	{
		//Log info
		console.info(`Parsing SMS with GSM geolocation from: ${tracker.data().name}`);
		
		//Get LAC from SMS text
		const lac_index = sms_text.indexOf("lac:") + "lac:".length;
		const lac = sms_text.substring(lac_index, sms_text.substring(lac_index).indexOf(" ") + lac_index);
		
		//Get CID from SMS text
		const cid_index = sms_text.indexOf("cid:") + "cid:".length;
		const cid = sms_text.substring(cid_index, sms_text.substring(cid_index).indexOf(" ") + cid_index);

		//Use google service for geolocation
		const coords = await geolocation.google('724', getMNC(tracker.data().network), lac, cid);
		
		//Create coordinates object
		const coordinates = new admin.firestore.GeoPoint(coords.lat, coords.lon);

		//Create notification alert if available on this message
		const alert_notification = buildNotification(sms_text.substring(0, sms_text.indexOf("!")));
		
		//Insert coordinates on db with default notification
		await insert_coordinates(tracker,
		{
			type: 'GSM',
			speed: 'N/D',
			batteryLevel: tracker.data().batteryLevel,
			signalLevel: tracker.data().signalLevel,
			datetime: new Date(),
			position: coordinates
		}, alert_notification);
	}
	else if(sms_text.indexOf("lac:") >= 0)
	{
		//Log info
		console.info(`Parsing SMS with GSM geolocation from: ${tracker.data().name}`);
		
		//Get LAC from SMS text
		const lac_index = sms_text.indexOf("lac:") + "lac:".length;
		const lac = sms_text.substring(lac_index, sms_text.substring(lac_index).indexOf(" ") + lac_index);
		
		//Get CID from SMS text
		const cid_index = sms_text.indexOf(lac) + lac.length;
		const cid = sms_text.substring(cid_index + 1, sms_text.substring(cid_index).indexOf("\n") + cid_index);

		//Use google service for geolocation
		const coords = await geolocation.google('724', getMNC(tracker.data().network), parseInt(lac, 16), parseInt(cid, 16));
		
		//Create coordinates object
		const coordinates = new admin.firestore.GeoPoint(coords.lat, coords.lon);

		//Create notification alert if available on this message
		const alert_notification = buildNotification(sms_text.substring(0, sms_text.indexOf("!")));
		
		//Insert coordinates on db with default notification
		await insert_coordinates(tracker,
		{
			type: 'GSM',
			speed: 'N/D',
			batteryLevel: tracker.data().batteryLevel,
			signalLevel: tracker.data().signalLevel,
			datetime: new Date(),
			position: coordinates
		}, alert_notification);
	}
	else if(sms_text.indexOf("lat") >= 0 && !sms_text.startsWith("last:"))
	{
		//Log info
		console.info(`Parsing SMS with GPS position from: ${tracker.data().name}`);

		//Get latitude from SMS text
		let index = sms_text.indexOf("lat:") + "lat:".length;
		const latitude = sms_text.substring(index, sms_text.substring(index).indexOf(" ") + index);

		//Get longitude from SMS text
		index = sms_text.indexOf("long:") + "long:".length;
		const longitude = sms_text.substring(index, sms_text.substring(index).indexOf(" ") + index);

		//Get speed from SMS text
		index = sms_text.indexOf("speed:") + "speed:".length;
		const speed = sms_text.substring(index, sms_text.substring(index).indexOf(" ") + index);

		//Get speed from SMS text
		index = sms_text.indexOf("bat:") + "bat:".length;
		const bat = sms_text.substring(index, sms_text.substring(index).indexOf("\n") + index);
		
		//Create coordinates object
		const coordinates = new admin.firestore.GeoPoint(parseFloat(latitude), parseFloat(longitude));

		//Create notification alert if available on this message
		const alert_notification = buildNotification(sms_text.substring(0, sms_text.indexOf("!")));

		//Insert coordinates on db
		await insert_coordinates(tracker, 
		{
			type: "GPS",
			batteryLevel: bat,
			signalLevel: tracker.data().signalLevel,
			datetime: new Date(),
			position: coordinates,
			speed: speed
		}, alert_notification);
	}
	else
	{
		//Log warning
		console.error("Unable to parse message from TK102B model:  " + sms_text);
	}
}

async function parseCobanProtocol(tracker, tcp_message)
{
	// Log data
	console.info(`Parsing TCP Message (COBAN PROTOCOL) received from tracker: ${tracker.data().name}`);

	// Check if default tracker location message
	if(tcp_message.content.length > 10) 
	{
		// Get if GPS signal is fixed
		if(tcp_message.content[4] === 'F')
		{
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
			await insert_coordinates(tracker, coordinate_params, buildNotification(tcp_message.content[1]));
		}
		else if(tcp_message.content[4] === 'L')
		{
			//Log data
			console.info('Requesting geolocation from cell tower');

			//Use google service for geolocation
			const coords = await geolocation.google('724', getMNC(tracker.data().network), parseInt(tcp_message.content[7], 16), parseInt(tcp_message.content[9], 16));

			//Geolocation results
			console.info('Result', coords);

			//Parse datetime (ex.: 181106115734)
			let datetime = moment.utc(tcp_message.content[2], 'YYMMDDhhmmss').toDate();

			//Get current date time
			const currentDatetime = new Date();

			//Check if datetime is valid
			if(datetime.getTime() > currentDatetime.getTime() || currentDatetime.getTime() - datetime.getTime() / 86400000 > 365)
			{
				//Use current datetime
				datetime = currentDatetime;
			}

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
			await insert_coordinates(tracker, coordinate_params, buildNotification(tcp_message.content[1]));
		}
		else if(tcp_message.content[1] === 'OBD')
		{
			//Log data
			console.info(`Received OBD message, appending to tracker ${tracker.data().name}`);

			//Append ODB information to tracker
			await tracker.ref.set({ vehicle_data:
			{
				odometer: tcp_message.content[3],
				remaining_fuel: tcp_message.content[4],
				average_fuel: tcp_message.content[5],
				driving_time: tcp_message.content[6],
				speed: tcp_message.content[7],
				power_load: tcp_message.content[8],
				water_temp: tcp_message.content[9],
				throttle_percentage: tcp_message.content[10],
				rpm: tcp_message.content[11],
				battery: tcp_message.content[12],
				dtc: tcp_message.content[13],
				datetime: new Date()
			}}, {merge: true})
		}
		else
		{
			//Throw error
			throw new Error('Unknown COBAN PROTOCOL data structure: Unexpected message content.');
		}
	}
	else
	{
		//Throw error
		throw new Error('Unknown COBAN PROTOCOL data structure: Not enough fields.');
	}
}

async function parseTK103Protocol(tracker, tcp_message)
{
	// Log data
	console.info(`Parsing TCP Message (TK103 PROTOCOL) received from tracker: ${tracker.data().name}`);

	// Check if default tracker location message (087075479117BR00181227A2304.5708S05412.4277W000.2132029000.00,00000000L00000000)
	if(tcp_message.content.length > 50 && tcp_message.content.substring(13, 17) === 'BR00') 
	{
		//Parse datetime (ex.: 181106115734) 
		const datetime = moment.utc(tcp_message.content.substring(17, 23) + tcp_message.content.substring(50, 56), 'YYMMDDhhmmss').toDate();

		// Get if GPS signal is fixed 
		if(tcp_message.content[23] === 'A')
		{
			//Parse coordinate from degrees/minutes to a GeoPoint
			const coordinates = new admin.firestore.GeoPoint(parseCoordinate(tcp_message.content.substring(24, 33), tcp_message.content[33]), parseCoordinate(tcp_message.content.substring(34, 44), tcp_message.content[44]));
			
			//Parse speed
			const speed = tcp_message.content.substring(45, 50);
			
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
			await insert_coordinates(tracker, coordinate_params, buildNotification(tcp_message.content.substring(13, 17)));
		}
		else
		{
			//Log data
			console.info('TK103 PROTOCOL message: GPS not fixed.');
		}
	}
	else
	{
		//Throw error
		throw new Error('Unknown TK103 PROTOCOL data structure');
	}
}

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

		//Flag indicating if any error ocurred
		let config_error = false;

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
				case 'ERROR':
					config_error = true;
					break;
			}
		})

		//Log data
		console.info(`Updating configuration ${configuration.name} on tracker ${tracker.id}: Status: ${configuration.status.step}`);

		//Update current configuration datetime
		configProgress.datetime = configuration.status.datetime;

		//Calculate configuration progress
		configProgress.progress = Math.ceil((configProgress.pending - currentPending )* 100 / configProgress.pending);

		//If configuration was received by the tracker
		if(configuration.status.step === "RECEIVED")
		{
			//Send notification to users subscribed on this topic
			await sendNotification(tracker.id, 'Notify_Available', {
				title: `Notificação de disponibilidade`,
				content: `Confirmado o recebimento de SMS`,
				expanded: `O rastreador recebeu a configuração enviada por mensagem de texto`,
				datetime: Date.now().toString()
			});
		}
		else if(configuration.status.step === "ERROR")
		{
			//Send notification to users subscribed on this topic
			await sendNotification(tracker.id, 'Notify_Available', {
				title: `Rastreador indisponível`,
				content: `A configuração não pode ser entregue ao rastreador`,
				expanded: `Dispositivo não disponível para o recebimento de solicitações`,
				datetime: Date.now().toString()
			});
		}

		//Check configuration status
		if(config_error)
		{
			//Configuration error
			configProgress.step = "ERROR";
			configProgress.description = configuration.description;
			configProgress.status = configuration.status.description;
		}
		else if (currentPending === 0)
		{
			//Configuration success
			configProgress.step = "SUCCESS";
			configProgress.description = configProgress.pending === 1 ? configuration.description : "Configuração finalizada";
			configProgress.status = "Processo realizado com sucesso";
		}
		else
		{
			//Configuration in progress
			configProgress.step = "PENDING";
			configProgress.description = configuration.description;
			configProgress.status = configuration.status.description;
		}

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

// Insert parsed coordinates to corresponding tracker collection
async function insert_coordinates(tracker: FirebaseFirestore.QueryDocumentSnapshot, coordinate_params, alert_notification)
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
		const new_coordinate = querySnapshot.empty || !tracker.data().lastCoordinate || coordinate_params.datetime > tracker.data().lastCoordinate.datetime.toDate()
	
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

				//If this is a new coordinate and no alert notification
				if(new_coordinate && !alert_notification)
				{
					//Sending notification to users subscribed on this topic
					await sendNotification(tracker.id, 'Notify_Move', 
					{
						title: `${previousCoordinate === null ? 'Posição do rastreador disponível' : 'Notificação de movimentação'}`,
						content: `${coordinate_params.type === 'GSM' ? '(Sinal de GPS fraco, localização aproximada)' : coordinate_params.address}`,
						coordinates: `${coordinate_params.type === 'GSM' ? '(GSM)_' : '(GPS)_'}${coordinate_params.position.latitude},${coordinate_params.position.longitude}`,
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

			//If this is a new coordinates and no alert notification
			if(new_coordinate && !alert_notification)
			{
				//Send notification to users subscribed on this topic
				await sendNotification(tracker.id, 'Notify_Stopped', {
					title: 'Notificação de permanência',
					content: `${coordinate_params.type === 'GSM' ? '(Sinal de GPS fraco, localização aproximada)' : 'Rastreador permanece na mesma posição.'}`,
					coordinates: `${coordinate_params.type === 'GSM' ? '(GSM)_' : '(GPS)_'}${coordinate_params.position.latitude},${coordinate_params.position.longitude}`,
					datetime: Date.now().toString()
				});
			}
			
			//Log info
			console.info(`Successfully parsed location message from: ${tracker.data().name} - Coordinate updated`);
		}

		//If alert notification available
		if(alert_notification)
		{
			//Send notification to users subscribed on this topic
			await sendNotification(tracker.id, 'Notify_Alert', alert_notification);
		}

		//If new coordinate
		if(new_coordinate)
		{
			//Get updated datetime from coordinate params
			coordinate_params.datetime = coordinate_params.lastDatetime ? coordinate_params.lastDatetime : coordinate_params.datetime;

			//Update tracker last coordinate field
			await firestore
				.collection('Tracker')
				.doc(tracker.id)
				.set({lastCoordinate: coordinate_params, lastUpdate: new Date()}, { merge: true })

			//Check if there is any pending configurations on this tracker
			if(tracker.data().lastConfiguration && tracker.data().lastConfiguration.step === "PENDING" && tracker.data().model === "tk102")
			{
				//Confirm location configuration
				await confirmConfiguration(tracker, "PeriodicUpdate", true, "ok");
			}
		}
	} 
	catch (error)
	{
		//Log error
		console.error('Error parsing TCP Message', error);
	}	
}

async function confirmConfiguration(tracker: FirebaseFirestore.QueryDocumentSnapshot, configName: string, enabled: boolean, response: string)
{
   //Get configuration reference by name
   const config_reference = await tracker.ref.collection(`Configurations`).doc(configName).get();

   //If configuration found
   if(config_reference.exists)
   {
      //Get configuration data
      const config = config_reference.data();

      //Check if config status is currently pending
      if(!config.status.finished)
      {
         //Change configuration status
         config.enabled = enabled;
         config.status.finished = true;
         config.status.datetime = admin.firestore.FieldValue.serverTimestamp();

			if(response.includes(`ok`))
         {
            //Show success message to user
            config.status.step = `SUCCESS`;
            config.status.description = `Configuração ${enabled ? `ativada` : `desativada`} pelo rastreador`;
         }
         else if(response.includes(`password err`) || response.includes(`pwd fail`))
         {
            //Show success message to user
            config.status.step = `ERROR`;
            config.status.description = `Dispositivo recusou a senha`;
         }
         else if (response.includes(`fail`))
         {
            //Show success message to user
            config.status.step = `ERROR`;
            config.status.description = `Dispositivo indicou erro`;
			}
			
			//Check for configurations IMEI or StatusCheck
         if(configName === `IMEI`)
         {
            //Update tracker to save IMEI
            await tracker.ref.update(`imei`, response);

            //Show success message to user
            config.status.step = `SUCCESS`;
            config.status.description = `Configuração confirmada pelo rastreador`;
            config.value = response;
         }
         else if(configName === `StatusCheck`)
         {
				//Initialize battery and signal level
				let index = 0;
				let battery_level = "N/D";
				let signal_level = "N/D";

				//Parse for tk102 models
				if(tracker.data().model === "tk102")
				{
					//Get battery level from SMS text
					index = response.indexOf(`bat: `) + `bat: `.length;
					battery_level = response.substring(index, response.substring(index).indexOf(`\n`) + index);

					//Get signal level from SMS text
					index = response.indexOf(`gsm: `) + `gsm: `.length;
					signal_level = (parseInt(response.substring(index, response.substring(index).indexOf(`\n`) + index))*10/3).toFixed(0) + `%`;
				}
				else if(tracker.data().model === "tk103")
				{
					//Get signal level from SMS text
					index = response.indexOf("gsm: ") + "gsm: ".length;
					signal_level = response.substring(index + 1, response.substring(index).indexOf(" ") + index);

					//Get battery level from SMS text
					index = response.indexOf("battery: ") + "battery: ".length;
					battery_level = response.substring(index + 1, response.length);

					//Fix battery level if battery is 100%
					battery_level = battery_level === "00%" ? "100%" : battery_level;
				}

            //Update value on firestore DB
            await tracker.ref.update({ signalLevel: signal_level, batteryLevel: battery_level });

            //Send notification to users subscribed on this topic
				await sendNotification(tracker.id, 'Notify_StatusCheck', {
               title: `Atualização de status`,
               content: `Bateria: ` + battery_level + ` / Sinal GSM: ` + signal_level,
               datetime: Date.now().toString()
				});

            //Show success message to user
            config.status.step = `SUCCESS`;
            config.status.description = `Configuração confirmada pelo rastreador`;
            config.value = response;
			}

			//Log data
			console.info(`Confirmed configuration ${configName} on tracker ${tracker.data().name}`, config);

         //Update configuration status on firestore DB
         await config_reference.ref.set(config);
		}
		else
		{
			//Log data
			console.info(`Configuration ${configName} already confirmed on tracker ${tracker.data().name}`, config);
		}
   }
	else
	{
		//Log data
		console.error(`Configuration ${configName} not found on tracker ${tracker.data().name}`);
	}
}

// Send Firebase Cloud Message to a specific topic
async function sendNotification(tracker_id: string, channel: string, params)
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

// Parse degree coordinate value (format: '2304.56556', 'S'), return as decimal -23.4204
function buildNotification(messageType: string)
{
	//Get notification type
	switch(messageType)
	{
		case 'help me':
			return {
				title: `Alerta de S.O.S`,
				content: `Pressionado o botão S.O.S. no rastreador`,
				datetime: Date.now().toString()
			};
			
		case 'move':
			return {
				title: `Alerta de movimentação`,
				content: `Movimentação além do limite determinado.`,
				datetime: Date.now().toString()
			};	

		case 'speed':
			return {
				title: `Alerta de velocidade`,
				content: `Velocidade além do limite determinado.`,
				datetime: Date.now().toString()
			};	

		case 'sensor alarm':
		case 'shock':
			return {
				title: `Alerta de vibração`,
				content: `Detectada vibração no dispositivo rastreador`,
				datetime: Date.now().toString()
			};
			
		case 'low battery':
			return {
				title: `Alerta de bateria fraca`,
				content: `Bateria do dispositivo rastreador em nível baixo`,
				datetime: Date.now().toString()
			};
								
		case 'ac alarm':
		case 'power alarm':
			return {
				title: `Alerta de energia`,
				content: `Dispositivo desconectado da fonte de energia externa`,
				datetime: Date.now().toString()
			};		

		case 'acc on':
			return {
				title: `Alerta de motor ligado`,
				content: `O motor do veículo foi ligado`,
				datetime: Date.now().toString()
			};

		case 'acc alarm':
			return {
				title: `Alerta de motor`,
				content: `O motor do veículo está em funcionamento`,
				datetime: Date.now().toString()
			};
			
		case 'acc off':
			return {
				title: `Alerta de motor desligado`,
				content: `O motor do veículo foi desligado`,
				datetime: Date.now().toString()
			};
		
		default:
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