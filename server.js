`use strict`;

//Import logger module
const logger = require(`./logger`);

//Import Google Services (Firebase, geocoding, geolocation)
const Google_Services = require(`./google`);

//Import local parsers
const TCP_Module = require(`./parsers/tcp`);
const SMS_Module = require(`./parsers/sms`);

//Import client module
const Client = require("./client")

//Get process params
const tcp_port = 5001;
const com_port = process.argv[2];
const server_name = process.argv[3];

//Initialize Google services 
const google_services = new Google_Services(`./functions/credentials.json`);

//Initialize TCP Parser
const tcp_parser = new TCP_Module(tcp_port);

//Initialize local tcp message buffer
const tcp_buffer = new Array();

//Initialize SMS Parser
const sms_parser = new SMS_Module(com_port);

//Initialize local sms message buffer
const sms_buffer = new Array();

//Initialize clients array
var clients = {};

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

//Handle client data comming from TCP protocol
tcp_parser.on(`client`, (data, tcp_socket) => 
{
	//If client is not connected yet
	if(!clients[data.source])
	{
		//Add new client to list
		clients[data.source] = new Client(data.source, sms_parser);
	}

	//Update tcp_socket from client
	clients[data.source].setConnection(tcp_socket);

	//Call method to parse data
	clients[data.source].parseData('tcp_data', data.content);
});

//Call method to check Firestore DB
monitorFirestore();

//Call method to check on local buffers every 30 seconds
monitorBuffers();

//Get a real time updates from Firestore DB -> Tracker collection
function monitorFirestore()
{
	//Log data
	logger.debug(`Initializing listener on SMS_Outbox collection`);

	//Initialize listener
	google_services
		.getDB()
		.collection(`SMS_Outbox`)
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
					logger.info(`SMS available to send: [${configuration_data.command}] -> ${configuration_data.to}`);

					//Append callback to be executed when SMS is sent
					configuration_data.callback = (sent, result) =>
					{
						//SMS successfully sent
						if(sent)
						{
							//Create transaction
							let batch = google_services.getDB().batch();

							//Create sms_sent reference
							const sms_sent = google_services.getDB().collection('SMS_Sent').doc();

							//Get sms outbox reference
							const sms_outbox = google_services.getDB().collection('SMS_Outbox').doc(docChange.doc.id);
							
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
								"status.sms_reference": sms_sent.path, 
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
							google_services.getDB().collection('SMS_Outbox').doc(docChange.doc.id).delete();

							//Get configuration reference
							const configuration_reference = google_services.getDB().doc(configuration_data.path);

							//Update configuration
							configuration_reference.update( 
							{
								"status.step": "ERROR",
								"status.sms_reference": null, 
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
					};

					//Request send SMS
					sms_parser.requestSend(configuration_data);
				}
			});
		
		}, err => {
		
			//Log error
			logger.error(`Error on tracker snapshot listener ${err}`);

			//Try to start method again
			monitorFirestore();
		});
}

function monitorBuffers()
{
	//Call method to check on TCP Buffer
	setInterval(checkBuffer, 30000, tcp_buffer, 'TCP_Inbox');

	//Call method to check on SMS buffers 
	setInterval(checkBuffer, 30000, sms_buffer, 'SMS_Inbox');
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