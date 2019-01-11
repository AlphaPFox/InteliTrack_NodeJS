`use strict`;

//Import logger module
const logger = require(`./logger`);

//Import Google Services (Firebase, geocoding, geolocation)
const Google_Services = require(`./google`);

//Import local parsers
const TCP_Module = require(`./parsers/tcp`);
const SMS_Module = require(`./parsers/sms`);

//Get process params
const server_module = process.argv[2];

//Initialize argument variables
let tcp_port;
let serial_port;
let server_name;

//Check server operation mode
switch(server_module)
{
	case 'TCP':
		//Operate as TCP server only, get TCP port as parameter
		tcp_port = process.argv[3];
		server_name = process.argv[4];
		break;

	case 'SMS':
		//Operate as SMS server only, get serial port as parameter
		serial_port = process.argv[3];
		server_name = process.argv[4];
		break;

	case 'HYBRID':
		//Operate both as TCP and SMS server, get TCP and serial port as parameter
		tcp_port = process.argv[3];
		serial_port = process.argv[4];
		server_name = process.argv[5];
		break;
	
	default:
		//Argument missing
		logger.warn("Select server mode: server.js TCP/SMS/HYBRID");
		return;
}

//Initialize Google services 
const google_services = new Google_Services(`./functions/credentials.json`);

//Check if TCP server is enabled
if(server_module === 'TCP' || server_module === 'HYBRID')
{
	//Initialize TCP Parser
	const tcp_parser = new TCP_Module(tcp_port);

	//Initialize local tcp message buffer
	const tcp_buffer = new Array();

	//Handle data comming from TCP protocol
	tcp_parser.on(`data`, (tcp_message) => 
	{
		//Call method to save data on Firestore
		saveOnFirestore(`TCP_Inbox`, tcp_message, 
		(success) => 
		{
			//On success, log info
			logger.info(`TCP Message -> Stored to Firestore DB at: ${success.path}`);
		},
		(error) =>
		{
			//On error, log message
			logger.error(`TCP Message -> Error saving on Firestore DB: ${error}`);
	
			//Store message on local buffer
			tcp_buffer.push(tcp_message);
		});
	});

	//Call method to check for pending TCP commands
	monitorCollection(`TCP_Outbox`, tcp_parser, TCPSent);
	
	//Call method to check on TCP Buffer every 30 seconds
	setInterval(checkBuffer, 30000, tcp_buffer, 'TCP_Inbox');
}

//Check if SMS server is enabled
if(server_module === 'SMS' || server_module === 'HYBRID')
{
	//Initialize SMS Parser
	const sms_parser = new SMS_Module(serial_port);

	//Initialize local sms message buffer
	const sms_buffer = new Array();

	//Handle SMS comming from modem
	sms_parser.on(`data`, (sms_message) => 
	{
		//Call method to save data on Firestore first
		saveOnFirestore(`SMS_Inbox`, sms_message, 
		(success) => 
		{
			//On success, log info
			logger.info(`SMS Message -> Stored to Firestore DB at: ${success.path}`);
		},
		(error) =>
		{
			//On error, log message
			logger.error(`SMS Message -> Error saving on Firestore DB: ${error}`);

			//Store message on local buffer
			sms_buffer.push(sms_message);
		});

		//Then delete from modem memory
		sms_parser.deleteMessage(sms_message);	
	});

	//Call method to check for pending SMS commands
	monitorCollection(`SMS_Outbox`, sms_parser, SMSSent);

	//Call method to check on SMS buffers 
	setInterval(checkBuffer, 30000, sms_buffer, 'SMS_Inbox');
}

//Get a real time updates from Firestore DB -> SMS_Outbox collection
function monitorCollection(collection, parser, sentCallback)
{
	//Log data
	logger.debug(`Initializing listener on ${collection} collection`);

	//Initialize listener
	google_services
		.getDB()
		.collection(collection)
		.onSnapshot(querySnapshot => 
		{
			//For each tracker load from snapshot
			querySnapshot.docChanges.forEach(docChange => 
			{			
				//If tracker is inserted or updated
				if(docChange.type === `added`)
				{
					//Get configuration data
					const configuration_data = docChange.doc.data();

					//Log data
					logger.info(`${collection} -> Command available to send: [${configuration_data.command}] -> ${configuration_data.to}`);

					//Append callback to be executed when SMS is sent
					configuration_data.callback = sentCallback.bind(docChange.doc);

					//Request send SMS
					parser.requestSend(docChange.doc.id, configuration_data);
				}
				else if(docChange.type === `removed`)
				{
					//Remove command from pending list
					parser.removeCommand(docChange.doc.id);
				}
			});
		
		}, err => {
		
			//Log error
			logger.error(`Error on tracker snapshot listener ${err}`);

			//Try to start method again
			monitorSMSOutbox();
		});
}

function checkBuffer(buffer, collection)
{
	//Log regular function
	logger.debug(`[${collection}] -> ${buffer.length == 0 ? `No` : buffer.length} messages on buffer`);

	//If any messages available on TCP buffer
	if(buffer.length > 0)
	{
		//Call method to save data on Firestore
		saveOnFirestore(collection, buffer[0], 
		(success) => 
		{
			//On success, log info
			logger.info(`[BUFFER] [${collection}] -> Stored to Firestore DB at: ${success.path}`);

			//Remove message from buffer
			buffer.shift();

			//Call method again to check if there is more messages
			checkBuffer(buffer, collection);
		},
		(error) =>
		{
			//On error, log message
			logger.debug(`[BUFFER] [${collection}] -> Firestore DB still not available: ${error}`);
		});
	}
}

//Function called when after a SMS command is sent
function SMSSent(sent, result)
{
	//Get configuration data
	const configuration_data = this.data();

	//SMS successfully sent
	if(sent)
	{
		//Create transaction
		let batch = google_services.getDB().batch();

		//Create sms_sent reference
		const sms_sent = google_services.getDB().collection('SMS_Sent').doc();

		//Get sms outbox reference
		const sms_outbox = google_services.getDB().collection('SMS_Outbox').doc(this.id);
		
		//Get configuration reference
		const configuration_reference = google_services.getDB().doc(configuration_data.path);

		//Create sms_sent document
		batch.set(sms_sent, 
		{
			server: server_name,
			reference: result,
			text: configuration_data.command,
			configuration: configuration_data.path,
			sent_time: google_services.getTimestamp(),
			status: `SENT`
		});

		//Update configuration
		batch.update(configuration_reference, 
		{
			"status.step": "SENT",
			"status.reference": sms_sent.path, 
			"status.datetime": google_services.getTimestamp(),
			"status.description": "Configuração enviada ao rastreador"
		});

		//Delete document from SMS outbox collection
		batch.delete(sms_outbox);

		//Run transacation
		batch
			.commit()
			.then(() =>
			{
				//Result sucess
				logger.info(`Command [${configuration_data.command}] sent to ${configuration_data.to}: Result saved at ${sms_sent.path}`);
			})
			.catch(error => 
			{
				//SMS sent, but failed to save on Firestore DB
				logger.warn(`Command [${configuration_data.command}] sent to ${configuration_data.to}: Could not save on firestore: ${error}`);
			});
	}
	else
	{
		//Delete SMS from outbox folder
		google_services.getDB().collection('SMS_Outbox').doc(this.id).delete();

		//Get configuration reference
		const configuration_reference = google_services.getDB().doc(configuration_data.path);

		//Update configuration
		configuration_reference.update( 
		{
			"status.step": "ERROR",
			"status.reference": null, 
			"status.datetime": google_services.getTimestamp(),
			"status.description": "Falha no envio da configuração"
		}).then(() =>
		{
			//Error sending SMS
			logger.error(`Error sending SMS command [${configuration_data.command}] to ${configuration_data.to}: ${result} - Updated configuration status`);
		})
		.catch(error => 
		{
			//SMS sent, but failed to save on Firestore DB
			logger.error(`Error sending SMS command [${configuration_data.command}] to ${configuration_data.to}: ${result} - Error updating configuration status ${error}`);
		});
	}
}

//Function called when after a TCP command is sent
function TCPSent()
{
	//Get configuration data
	const configuration_data = this.data();

	//Create transaction
	let batch = google_services.getDB().batch();

	//Create TCP_Sent reference
	const tcp_sent = google_services.getDB().collection('TCP_Sent').doc();

	//Get tcp outbox reference
	const tcp_outbox = google_services.getDB().collection('TCP_Outbox').doc(this.id);
	
	//Get configuration reference
	const configuration_reference = google_services.getDB().doc(configuration_data.path);

	//Create sms_sent document
	batch.set(tcp_sent, 
	{
		server: server_name,
		text: configuration_data.command,
		configuration: configuration_data.path,
		sent_time: google_services.getTimestamp(),
		status: `SENT`
	});

	//Update configuration
	batch.update(configuration_reference, 
	{
		"status.step": "SENT",
		"status.reference": tcp_sent.path, 
		"status.datetime": google_services.getTimestamp(),
		"status.description": "Configuração enviada ao rastreador"
	});

	//Delete document from SMS outbox collection
	batch.delete(tcp_outbox);

	//Run transacation
	batch
		.commit()
		.then(() =>
		{
			//Result sucess
			logger.info(`TCP command [${configuration_data.command}] sent to ${configuration_data.to}: Result saved at ${tcp_sent.path}`);
		})
		.catch(error => 
		{
			//SMS sent, but failed to save on Firestore DB
			logger.warn(`TCP command [${configuration_data.command}] sent to ${configuration_data.to}: Could not save on firestore: ${error}`);
		});
}

function saveOnFirestore(collection, messageData, onSuccess, onError)
{
	//Append server name to sms message
	messageData.server_name = server_name;

	//Append server name to sms message
	messageData.server_datetime = google_services.getTimestamp();

	//Save SMS data on Firestore (parsed latter on Cloud Functions)
	google_services
		.getDB()
		.collection(collection)
		.add(messageData)
		.then(onSuccess)
		.catch(onError);
}