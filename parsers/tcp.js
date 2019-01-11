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
		this._tcp_outbox = {};

		//Initialize server
		this.initialize();
	}
		 
	getConnection(tracker_id)
	{
		//Return tcp socket if available
		return this._connections[tracker_id];
	}

	setConnection(tracker_id, connection)
	{
		//Store tcp socket on connection array
		this._connections[tracker_id] = connection;

		//Check for disconnect callback
		if(!connection.onDisconnect)
		{
			//Store on disconnect method
			connection.onDisconnect = () =>
			{
				//Remove from connection array
				delete this._connections[tracker_id];

				//Emit disconnect
				this.emit('data', { source: tracker_id, type: 'DISCONNECTED' });
			}
		}

		//Check pending commands for this tracker
		this.checkPendingCommands(tracker_id);
	}

	getPendingCommands()
	{
		//Return tcp outbox list
		return this._tcp_outbox;
	}

	//Append command to outbox list
	requestSend(reference, configuration)
	{
		//Store TCP on send list
		this._tcp_outbox[reference] = configuration;
	}

	//Check for pending commands
	checkPendingCommands(tracker_id)
	{
		//For each pending commands
		for(let reference in this._tcp_outbox)
		{
			//Get configuration data
			const config = this._tcp_outbox[reference];

			//If command available to this tracker
			if(config.to === tracker_id)
			{
				//Try to send command
				if(this.sendCommand(config.to, config.command))
				{
					//If sent, run command callback function
					config.callback();

					//Delete from command list
					delete this._tcp_outbox[reference];
				}

				//End method to avoid sending multiple commands at once
				return;
			}
		}
	}

	//Remove command from list
	removeCommand(reference)
	{
		//Delete command from list
		delete this._tcp_outbox[reference];
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

					//Save on connection array
					this.setConnection(imei, conn);

					//Reply connection to tracker
					this.sendCommand(imei, "ON");
				}
				else if(data.startsWith("imei"))
				{
					//Split data using ';' separator
					var content = data.split(',');

					//Save on connection array
					this.setConnection(imei, conn);

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
         
					//If emergency message type
					if(content[1] === 'Emergency')
					{
						//Send acknowlegde command to tracker
						this.sendCommand('ACK;' + suntech_id);
					}
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

      //Command not sent, return error
      return false;
   }
}

module.exports = TCP_Parser