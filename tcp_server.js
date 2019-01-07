`use strict`;

//Import logger module
const logger = require(`./logger`);

//Import Google Services (Firebase, geocoding, geolocation)
const Google_Services = require(`./google`);

//Import local parsers
const TCP_Module = require(`./parsers/tcp`);

//Get process params
const tcp_port = process.argv[2];
const server_name = process.argv[3];

//Initialize Google services 
const google_services = new Google_Services(`./functions/credentials.json`);

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

//Call method to check on local buffers every 30 seconds
setInterval(checkBuffer, 30000, tcp_buffer, 'TCP_Inbox');

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
	//Append server name to message
	messageData.server_name = server_name;

	//Append server datetime to message
	messageData.server_datetime = google_services.getTimestamp();

	//Save SMS data on Firestore (parsed latter on Cloud Functions)
	google_services
		.getDB()
		.collection(collection)
		.add(messageData)
		.then(onSuccess)
		.catch(onError);
}