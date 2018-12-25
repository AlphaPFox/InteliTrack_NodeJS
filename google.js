//Load Google Services data from file
const admin = require("firebase-admin");

//Import logger
const logger = require('./logger');

//Import geocoding services
const node_geocoder = require('node-geocoder');

//Define methods and properties
class Google_Services
{
  	constructor(credentials) 
  	{
		//Get firebase credentials
		var serviceAccount = require(credentials);

		//Initialize admin SDK
		admin.initializeApp({
			credential: admin.credential.cert(serviceAccount),
			databaseURL: "https://intelitrack-b3fc8.firebaseio.com"
		});

		//Store Firebase Admin object
		this._admin = admin;

		//Initialize using google maps static api key
		var geocoder = node_geocoder({
			provider: 'google',
			apiKey: 'AIzaSyAq8QebBfeR7sVRKErHhmysSk5U80Zn3xE', // for Mapquest, OpenCage, Google Premier
		});
	 
		//Set google services debug function
		//admin.firestore.setLogFunction(message => { logger.debug(message); });

		//Load Firebase Firestore DB manager and Cloud Messaging
		this._db = admin.firestore();
		this._db.settings({timestampsInSnapshots: true});

		//Load Firebase Cloud Messaging
		this._fcm = admin.messaging();

		//Save geolocation and geocoding services
		this._geocoder = geocoder;

		//Log data
		logger.info("Google services successfully initialized.")
  }

  //Get Firestore Database
  getDB() {
      return this._db;
  };

  //Get Firebase Cloud Messaging
  getFCM() {
    return this._fcm;
  };

  //Get Firebase Admin service
  getFirestore() {
    return this._admin.firestore;
  };

  getTimestamp() {
	  return this._admin.firestore.FieldValue.serverTimestamp();
  }

  //Get Geolocation Services
  getGeolocation() {
      return this._geolocation;
  };

  //Get Geocoding Services
  getGeocoder() {
      return this._geocoder;
  };
}

module.exports = Google_Services