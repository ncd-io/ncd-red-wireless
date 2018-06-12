const NCD = require('./index.js');
const comm = require('ncd-red-comm');

const Queue = require("promise-queue");

var serial = new comm.NcdSerial('/dev/tty.usbserial-A106F1ZE', 9600);
var modem = new NCD.Modem(serial);
var gateway = new NCD.Gateway(modem);
//console.log(gateway);
modem.send.at_command("ID").then((res) => {
	console.log("Network ID: "+res.data.map((v) => v.toString(16)).join(""));
	modem.send.at_command("HP").then((res) => {
		console.log(res);
		//console.log("Network ID: "+res.data.map((v) => v.toString(16)).join(""));
	});
});

gateway.on('sensor_data', (d) => {
	var type;
	if(typeof gateway.sensor_types[d.sensor_type] == 'undefined'){
		type = "unknown";
		console.log(d);
	}
	else type = gateway.sensor_types[d.sensor_type].name;
	console.log("Incoming data -------------------");
	console.log("Type: "+type);
	console.log("Address: "+d.addr);
	console.log("Readings: ");
	for(var i in d.sensor_data) console.log(`	${i}: ${d.sensor_data[i]}`);
	console.log("---------------------------------")
});
var config_queue = new Queue(1);
gateway.on('sensor_mode', (sensor) => {
	var mac = sensor.mac;
	console.log(sensor);
	if(sensor.mode == 'PGM'){
		config_queue.add(() => {
			return new Promise((fulfill) => {
				setTimeout(fulfill, 1000);
			});
		});
		config_queue.add(() => {
			return new Promise((fulfill, reject) => {
				console.log('Getting Destination:');
				gateway.config_get_destination(mac).then((res) => {
					console.log(res);
				}).catch((err) => {
					console.log(err);
				}).then(fulfill);
			});
		});
		config_queue.add(() => {
			return new Promise((fulfill, reject) => {
				console.log('Getting Delay:');
				gateway.config_get_delay(mac).then((res) => {
					console.log(res);
				}).catch((err) => {
					console.log(err);
				}).then(fulfill);
			});
		});
		config_queue.add(() => {
			return new Promise((fulfill, reject) => {
				console.log('Getting Power:');
				gateway.config_get_power(mac).then((res) => {
					console.log(res);
				}).catch((err) => {
					console.log(err);
				}).then(fulfill);
			});
		});
		config_queue.add(() => {
			return new Promise((fulfill, reject) => {
				console.log('Getting Retries:');
				gateway.config_get_retries(mac).then((res) => {
					console.log(res);
				}).catch((err) => {
					console.log(err);
				}).then(fulfill);
			});
		});
		config_queue.add(() => {
			return new Promise((fulfill, reject) => {
				console.log('Getting Network ID:');
				gateway.config_get_pan_id(mac).then((res) => {
					console.log(res);
				}).catch((err) => {
					console.log(err);
				}).then(fulfill);
			});
		});
	}
});
