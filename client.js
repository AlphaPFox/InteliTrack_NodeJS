//Import logger module
const logger = require('./logger');

//Extends base tracker class
class Client
{
   constructor(auth, sms_parser) 
   {
		//Store data
		this._auth = auth;
		this._sms_parser = sms_parser;
	}

	getParser()
	{
		return this._sms_parser;
	}
		
	getAuth()
	{
		return this._auth;
	}

   //Save tcp socket while connection is open
   setConnection(socket)
   {
		//If client is connecting from a different port (new connection)
		if(this._socket && this._socket.remotePort != socket.remotePort)
		{
			//Destroy previous connection
			this._socket.destroy();
		}

      //Save connection socket
      this._socket = socket;
   }

   //Return last TCP socket used by this client
   getConnection()
   {
      //Return socket
      return this._socket;
	}
	
	//Set phone number the client is currently testing
	setPhoneNumber(phoneNumber)
	{
		//Save connection socket
		this._phoneNumber = phoneNumber;
	}

	//Return phone number the client is currently testing
	getPhoneNumber()
	{
		//Save connection socket
		return this._phoneNumber;
	}

	//Close TCP connection
	disconnect()
	{
		//If connection available
		if(this._socket)
		{
			//End connection
			this._socket.destroy();
		}
	}

   //Parse data from client
   parseData(type, data)
   {
		if(type == "tcp_data")
		{
			//Request to authenticate
			if(data.length > 3)
			{
				//Auth request
				if(data[3].trim() == "CONNECT")
				{
					//Respond authentication success to client
					this.sendResponse("AUTH: OK")
				}
				else if(data[3].trim() == "TEST")
				{
					//Save phone number client wants to test
					this.setPhoneNumber(data[5].trim());

					//Append callback to be executed when SMS is sent
					const configuration_data = 
					{
						to: data[5].trim(),
						command: `imei${data[6].trim()}`,
						callback: (sent, result) =>
						{
							//SMS successfully sent
							if(sent)
							{
								//Respond success to client
								this.sendResponse("SMS SENT");

								//Log data
								logger.debug("Sent test SMS to " + this.getPhoneNumber() + ": imei" + data[6].trim());
							}
							else
							{
								//Error sending SMS
								logger.error(`Error sending SMS command [${configuration_data.command}] to ${configuration_data.to}: ${result}`);
							}
						}
					}

					//Request send SMS
					this.getParser().requestSend(configuration_data);

					//Set this as a client
					this.getParser().setClient(data[5].trim(), this);
				}
			}
		} 
		else if(type == "delivery_report")
		{
			//Append client auth to data
			data.client = this.getAuth();

			//Check if status == DELIVERED
			if(data.status == 0)
			{
				//Respond success to client
				this.sendResponse("DELIVERY REPORT")
			}
			else
			{
				//Respond error to client
				this.sendResponse("Erro: Não foi possível confirmar entrega do SMS.");
			}
		}
		else if(type == "sms_received")
		{
			//Append client auth to data
			data.client = this.getAuth();
			
			//Log data 
			logger.debug('Received SMS, testing tracker ' + this.getPhoneNumber() + ": " + data.text);

			//Remove null bytes from string
			var sms_text = data.text.replace(/\D/g,'');

			//Check if SMS is an valid IMEI
			if(sms_text.length == 15)
			{
				//Respond success to client
				this.sendResponse("IMEI: " + sms_text);
			}
			else
			{
				//Respond error to client
				this.sendResponse("Erro: Resposta inválida do rastreador");
			}

			//Remove from parser list
			this.getParser().setClient(this.getPhoneNumber(), null);
			
			//Finish connection
			this.disconnect();
		}
   }

   sendResponse(command)
   {
      //Get tcp connection to tracker if available
      var connection = this.getConnection();

      //Check if connection socket exists
      if(connection != null)
      {
         //Check if connection is active
         if(connection.writable)
         {
            try
            {
               //Send command to tracker
               connection.write(command + "\n");

               //Log data
               logger.debug('Client@' + this.getAuth() + ' (' + connection.remoteAddress + ') <- [' + command + "]");

               //Command sent, return ture
               return true;
            }
            catch(error)
            {
                  //Log error
                  logger.error('Error sending command to client #' + this.getAuth() + " - Error: " + error + " / Command: " + command);
            }
         }
         else
         { 
            //Log warning
            logger.debug('Client@' + this.getAuth() + " have pending commands, but the connection is no longer valid.");
         }
      }
      else
      {
         //Log warning
         logger.debug('Client@' + this.getAuth() + " have pending commands but hasn't connected yet.");
      }

      //Command not sent, return error
      return false;
	}
}

module.exports = Client