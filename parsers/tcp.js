//Imports package used to create a TCP server
var net = require('net');

//Import event emiter class
const EventEmitter = require('events');

//Import logger
const logger = require('../logger');

//Define methods and properties
class TCP_Parser extends EventEmitter
{
	constructor (tcp_port)
	{
		//Call parent constructor
		super();

		//Initialize server
		this._server = net.createServer();
		this._tcp_port = tcp_port;
		this._connections = {};

		//Initialize server
		this.initialize();
	}
	 
	getConnection(id)
	{
		//Return tcp socket if available
		return this._connections[id];
	}

	setConnection(id, connection)
	{
		//Store tcp socket on connection array
		this._connections[id] = connection;

		//Store on disconnect method
		connection.onDisconnect = () =>
		{
			//Remove from connection array
			delete this._connections[id];

			//Emit disconnect
			this.emit('data', { source: id, type: 'DISCONNECTED' });
		}
	}

	initialize()
	{
		//Define actions on new TCP connection
		this._server.on('connection', conn => 
		{				
			//Log connection
			logger.info('TCP (' +  conn.remoteAddress + ":" + conn.remotePort + ") -> Connected");

			//Set enconding
			conn.setEncoding('utf8');

			//On receive data from TCP connection
			conn.on('data', data => 
			{
				//Log data received
				logger.info("TCP (" + conn.remoteAddress + ":" + conn.remotePort + ") -> [" + data.replace(/\r?\n|\r/, '') + "]");

				//Check if this is COBAN GPRS protocol
				if(data.startsWith('##'))
				{
					//Split data using ';' separator
					var content = data.split(',');
					
					//Check if connection contains imei data
					if(content[1] && content[1].startsWith("imei:"))
					{
						//Heartbeat packet, retrieve imei 
						var imei = content[1].substring(5);

						//Save on connection array
						this.setConnection(imei, conn);

						//Reply connection to tracker
						this.sendCommand(imei, "LOAD");
										
						//Emit connect message
						this.emit('data', { source: imei, type: 'CONNECTED' });
					}
				}
				else if(data.length == 16 && !isNaN(data.substring(0,15)))
				{
					//Heartbeat packet, retrieve imei 
					var imei = data.substring(0,15);

					//Reply connection to tracker
					this.sendCommand(imei, "ON");
				}
				else if(data.startsWith("imei"))
				{
					//Split data using ';' separator
					var content = data.split(',');

					//Call method to handle tcp data
					this.emit('data',
					{ 
						source: content[0].substring(5), 
						type: 'COBAN_PROTOCOL',
						content: content
					});
				}
				else if(data.includes("ST910"))
				{
					//Split data using ';' separator
					var content = data.split(';');

					//Retrieve tracker ID from message (last imei digits)
					var suntech_id = (content[1] == 'RES' ? content[3].trim() : content[2].trim());

					//Call method to handle tcp data
					this.emit('data',
					{ 
						source: suntech_id, 
						type: 'SUNTECH_PROTOCOL',
						content: content
					});

					//Save on connection array
					this.setConnection(suntech_id, conn);
				}
				else if(data.includes("BP00"))
				{
					//TK103_Protocol type
					var tracker_id = data.substring(1, 13);

					//Emit connect message
					this.emit('data', { source: tracker_id, type: 'CONNECTED' });

					//Save on connection array
					this.setConnection(tracker_id, conn);

					//Reply connection to tracker
					this.sendCommand(tracker_id, "(" + tracker_id + "AP01HSO)");
				}
				else if(data.includes("BP05"))
				{
					//TK103_PRotocol type
					var tracker_id = data.substring(1, 13);

					//Emit connect message
					this.emit('data', { source: tracker_id, type: 'CONNECTED' });

					//Save on connection array
					this.setConnection(tracker_id, conn);

					//Reply connection to tracker
					this.sendCommand(tracker_id, "(" + tracker_id + "AP05)");
				}
				else if(data.includes("BR00"))
				{
					//TK103_PRotocol type
					var tracker_id = data.substring(1, 13);

					//Call method to handle tcp data
					this.emit('data',
					{ 
						source: tracker_id, 
						type: 'TK103_PROTOCOL',
						content: data
					});

					//Save on connection array
					this.setConnection(tracker_id, conn);
				}
				else if(data.includes("CLIENT_AUTH"))
				{
					//Split data using ';' separator
					var content = data.split('_');

					//Get client ID
					var client_id = content[2];

					//Call method to handle tcp data
					this.emit('client',
					{ 
						source: client_id, 
						content: content
					}, conn);
				}
				else if(data.length > 5)
				{
					//Log warning
					logger.warn("Unknown data structure received from TCP connection");
				}
			});

			//On TCP connection close
			conn.on('close', function () 
			{
				//Log info
				logger.info('TCP (' +  conn.remoteAddress + ") -> Disconnected");
				
				//Check if disconnect method is available
				if(conn.onDisconnect)
				{
					//Call method to notify user
					conn.onDisconnect();
				}
			});

			//On TCP connection error
			conn.on('error', err => 
			{
				//Log error
				logger.error('TCP (' +  conn.remoteAddress + ") -> Error: " + err.message);
			});
		});

		//Set error handler
		this._server.on("error", error =>
		{
			//Log error
			logger.error('Error opening TCP port: ' + this._tcp_port + " / Error: " + error);
		});

		//Start listening for TCP connections
		this._server.listen(this._tcp_port, () => {  

			//Log info
			logger.info('TCP server listening to port: ' +  this._tcp_port);
		});
		
	}
	 
	sendCommand(destination, command)
   {
		//Get tcp connection to tracker if available
		var connection = this.getConnection(destination);

      //Check if connection socket exists
      if(connection != null)
      {
         //Check if connection is active
         if(connection.writable)
         {
            try
            {
               //Send command to tracker
               connection.write(command);

               //Log data
               logger.info(destination + "@" + connection.remoteAddress + " <- [" + command + "]");

               //Command sent, return ture
               return true;
            }
            catch(error)
            {
					//Log error
					logger.error("Error sending command to " + destination + "@" + connection.remoteAddress + " <- [" + command + "]");
            }
         }
         else
         { 
            //Log warning
            logger.warn("Cannot send [" + command + "] to " + destination + " - Connection is no longer valid.");
         }
      }
      else
      {
         //Log warning
         logger.warn("Cannot send [" + command + "] to " + destination + " - Not connected to this server.");
      }

      //Command not sent, return error
      return false;
   }
}

module.exports = TCP_Parser