const NCD = require('./index.js');
const comm = require('ncd-red-comm');

var serial = new comm.NcdSerial('/dev/tty.usbserial-A106EM3X', 9600);
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
