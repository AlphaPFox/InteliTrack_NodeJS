//Import log manager
var winston = require('winston');

//Define application log format
const logFormat = winston.format.combine
(
	 winston.format.timestamp(),
	 winston.format.colorize(),
    winston.format.printf(function (info) 
    {
      const { timestamp, level, message, ...args} = info;
      return `${info.timestamp} - ${info.level}: ${info.message} ${Object.keys(args).length ? JSON.stringify(args, null, 2) : ''}`;
    })
);

const logger = winston.createLogger({
	level: 'debug',
   format: logFormat,
   handleExceptions: true,
	stderrLevels: ["warn", "error"],
	transports: [
	  //
	  // - Write to all logs with level `info` and below to `debug.log` 
	  // - Write all logs warnings and errors to `error.log`.
	  //
	  new winston.transports.Console(),
	  new winston.transports.File({ filename: 'error.log', level: 'warn', maxsize: '2000000', maxFiles: 3, tailable: true }),
	  new winston.transports.File({ filename: 'debug.log', maxsize: '2000000', maxFiles: 3, tailable: true })
	]
 });

//Do not exit on errorls
logger.exitOnError = false;

//Export winston logger
module.exports = logger;