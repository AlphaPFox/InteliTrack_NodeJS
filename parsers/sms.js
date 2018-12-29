//Import GSM modem package
var modem = require('../libs/modem');

//Import event emiter class
const EventEmitter = require('events');

//Import logger
const logger = require('../logger');

//Define methods and properties
class SMS_Parser extends EventEmitter
{
  	constructor(com_port)
  	{
		//Call parent constructor
		super();

		//Initialize SMS array
		this._sms_sent = {};
		
		//Initialize SMS outbox array
		this._sms_outbox = [];

		//Initialize client array
		this._clients = [];

		//Save com port
		this._com_port = com_port;

		//Phone number
		this._phone_number = 'Not available';

		//Initialize modem
		this.setModem(new modem());

		//Initialize modem configuration
		this.configureModem(this.getModem());

		//Initialize an periodic check for modem status (every 5 seconds)
		setInterval(this.periodicCheck.bind(this), 5000);
  	}

	//Get modem used to receive data
	getModem()
	{
		//Return modem controller
		return this._modem;
	}

	//Get modem used to receive data
	setModem(modem)
	{
		//Return modem controller
		this._modem = modem;
	}

	//Get phone number from modem
	getPhoneNumber()
	{
		//Return value
		return this._phone_number;
	}
  
	//Set phone number after retrieved from modem
	setPhoneNumber(value)
	{
		//Set value
		this._phone_number = value;
	}

	//Get modem used to receive data
	getSentSMS(sms_reference)
	{
		//Return modem controller
		return this._sms_sent[sms_reference];
	}
	
	//Append SMS to outbox list
	requestSend(sms_data)
	{
		//Store SMS on send list
		this._sms_outbox.push(sms_data);
	}

	//Append client to list
	setClient(phoneNumber, client)
	{
		//Save client
		this._clients[phoneNumber] = client;
	}

	//Get client by phone number
	getClient(phoneNumber)
	{
		return this._clients[phoneNumber];
	}

	configureModem(modem)
   {
      //Error handling'
      modem.on('error', error =>
      {
         //Close connection to modem
         modem.close(error);
      });

      //On modem connection closed
      modem.on('close', reason => 
      {
         //Log warning 
         logger.debug("Modem connection closed: " + reason);
      });

      //Open connection on modem serial port
      modem.open(this._com_port, () =>
      {			
         //On command sent to modem
         modem.on('command', function(command) 
         {
            //Log command
            logger.debug("Modem <- [" + command + "] / Memmory Usage -> " + process.memoryUsage().rss);
         });

         //Execute modem configuration (RESET MODEM)
         modem.execute("ATZ");

         //Execute modem configuration (DISABLE ECHO)
         modem.execute("ATE0");

         //Execute modem configuration (ENABLE TX/RX)
         modem.execute("AT+CFUN=1,1");

         //Execute modem configuration (SET PDU MODE)
         modem.execute("AT+CMGF=0");

         //Execute modem configuration (ENABLE ERROR MESSAGES)
         modem.execute("AT+CMEE=2");

         //Execute modem configuration (ENABLE NETWORK REGISTRATION EVENT)
         modem.execute("AT+CREG=1");

         //Execute modem configuration (ENABLE AUTOMATIC NETWORK REGISTRATION)
         modem.execute("AT+COPS=0,1");

         //Execute modem configuration (REQUEST DELIVERY REPORT)
         modem.execute("AT+CSMP=49,167,0,0");

         //Execute modem command (REQUEST MANUFACTURER)
         modem.execute("AT+CGMI", function(response)
         {
            //If this is a HUAWEI MODEM
            if(response.includes('huawei'))
            {
               //Execute modem configuration (REQUEST SMS NOTIFICATION - HUAWEI)
               modem.execute("AT+CNMI=2,1,0,2,0");
            }
            else
            {
               //Execute modem configuration (REQUEST SMS NOTIFICATION - DLINK)
               modem.execute("AT+CNMI=2,1,0,1,0");
            }
         });

         //Execute modem command (REQUEST PHONE NUMBER)
         modem.execute("AT+CNUM", (response) =>
         {
            //Get start index from the phone number
            var startIndex = response.indexOf('55');

            //If this is a HUAWEI MODEM
            if(startIndex > 0)
            {
               //Remove first part of response string
               response = response.substring(startIndex);

               //Get phone number
               this.setPhoneNumber(response.substring(2, response.indexOf('"')));

               //Log information
               logger.info("Modem successfully initialized: " + this.getPhoneNumber());
            }
            else
            {
               //Log error
               logger.error("Error retrieving phone number: " + response);
            }
         });

         //On SMS received
         modem.on('sms received', (sms) =>
         {
            //Format phone number
            sms.sender = this.formatPhoneNumber(sms.sender);

            //Log output
            logger.debug("SMS RECEIVED", sms);

            //If message is only delivery confirmation text
            if(sms.text.startsWith(`Torpedo SMS entregue`))
            {
               //Delete from modem memory
               this.deleteMessage(sms);	
            }
				else 
				{
					//Check if this can be from a client request
					if(this.getClient(sms.sender))
					{
						//Send message to be parse by client
						this.getClient(sms.sender).parseData("sms_received", sms);
					}

					//Call method to handle sms
					this.emit('data', sms);
				}
         });
         
         //On SMS delivery receipt received
         modem.on('delivery', (delivery_report) =>
         {
            //Format phone number
            delivery_report.sender = this.formatPhoneNumber(delivery_report.sender);

            //Log output
				logger.debug("DELIVERY REPORT", delivery_report);
				
				//Check if any client associated with this phone number
				if(this.getClient(delivery_report.sender))
            {
					//Send message to be parse by client
					this.getClient(delivery_report.sender).parseData("delivery_report", delivery_report);
				}

				//Call method to handle delivery report
				this.emit('data', delivery_report);
			});
			
         //On data received from modem
         modem.on('data', function(data) 
         {
            //Log any data ouput from modem
            logger.debug("Modem -> [" + data.join().replace(/(\r\n|\n|\r)/gm,"") + "]");
         });

         //On data received from modem
         modem.on('modem info', info =>
         {
            //Check if modem is registered on network
            if(!info.registered)
            {
               //Log warning
               logger.warn("Modem not registered, increasing error counter");

               //Increase error counter
               this.getModem().errorCounter++;
            }

         });

         //On modem memmory full
         modem.on('memory full', function(sms) 
         {
            //Execute modem command (DELETE ALL MESSAGES)
            modem.execute("AT+CMGD=1,4", function(escape_char, response) 
            {
               //Log data
               logger.info("Modem memory full, erasing SMS: " + response)
            });
         });
      });
  }

  sendSMS(phoneNumber, text, callback)
  {
    //Send command to request current position
    this._modem.sms({
      receiver: phoneNumber,
      text: text,
      encoding:'16bit'
    }, 
    (result, reference) =>
    {
      //if any error ocurred
      if(result == "SENT")
      {
      	//Result success
        	callback(true, reference);
      }
      else
      {
			//Result error
			callback(false, reference);
      }
    });
  }

  periodicCheck()
  {
      //Get modem controller
      var modem = this.getModem();

      //Check if modem connection is open and no errors
      if(modem.isOpened && modem.errorCounter < 5)
      {
         //Execute modem command (REQUEST MODEM NETWORK CODE)
         modem.execute("AT+COPS?");

         //Execute modem command (REQUEST MODEM SIGNAL STRENGTH)
         modem.execute("AT+CSQ");

         //Execute modem command (REQUEST MODEM SYSTEM INFO)
			modem.execute("AT^SYSINFO");
			
			//Check for messages
			modem.getMessages();
      }
      else
      {
         //Check if error is due network registration failure
         if(modem.info && !modem.info.registered && !modem.reset_requested)
         {
            //Attempt to reset modem first
            modem.execute("AT+CFUN=0,1");

            //Inform modem reset request
            modem.reset_requested = true;

            //Log data
            logger.debug("Modem registration failed, reseting modem");
         }
         else if (modem.isOpened)
         {
            //Close previous modem connection (if still open)
            modem.close("Too many errors, reseting counter...");
         }
         else
         {
            //Perform modem configuration steps
            this.configureModem(modem);
         }
		}
		
		//Check if any sms available to send
		if(this._sms_outbox.length > 0)
		{
			//Log data
			logger.debug(`Sending SMS from outbox`);

			//Get first SMS to send
			const configuration_data = this._sms_outbox.shift();

			//Send SMS to request command
			this.sendSMS(configuration_data.to, configuration_data.command, configuration_data.callback);
		}
  }

  //Delete SMS from modem memory
  deleteMessage(sms)
  {

    //Call modem to request sms delete
    this.getModem().deleteMessage(sms);
  }

  formatPhoneNumber(number)
  {
    //Remove country digit indicator
    number = number.replace('+','');
    
    //Remove BR international code (if exists)
    if(number.startsWith('55'))
      number = number.replace('55', '');

    //Remove leading 0 (if exists)
    if(number.startsWith('0'))
      number = number.replace('0','');

    //Return formated number
    return number;
  }
}

module.exports = SMS_Parser