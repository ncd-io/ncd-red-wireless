const NCD = require('./index.js');
const comm = require('ncd-red-comm');

var serial = new comm.NcdSerial('/dev/tty.usbserial-A106EM3X', 9600);
var modem = new NCD.Modem(serial);
var gateway = new NCD.Gateway(modem);

gateway.on('found_sensor', (sensor) => {
	console.log('sensor of type '+sensor.type+' found at '+sensor.mac);
});
gateway._emitter.once('sensor_mode', (sensor) => {
	if(sensor.mode == "PGM"){
		console.log('Getting Pan ID');
		//modem.send.remote_at_command(mac2bytes(sensor.mac), 'ID').then(console.log).catch(console.log);
		var broadcast = "00:00:00:00:00:00:FF:FF"
		setTimeout(() => {
			//  gateway.config_get_pan_id(sensor.mac).then(console.log).catch(console.log);
			 //gateway.config_set_pan_id(sensor.mac, 0x7FFF).then(console.log).catch(console.log);
		}, 500);
	}
});
gateway.on('sensor_mode', (sensor) => {
	console.log('sensor at '+sensor.mac+' now in '+sensor.mode+' mode');
});
gateway.on('sensor_data', (data) => {
	console.log(data);
});



modem.send.at_command("ID").then(() => {
	//gateway.config_set_pan_id("00:13:a2:00:41:57:16:e1", 0x7BCE).then(console.log).catch(console.log);
	 gateway.config_get_pan_id("00:13:a2:00:41:57:16:e1").then(console.log).catch(console.log);
}).catch((e) => {
	console.log({error: e});
});


// var sensor = new NCD.Sensor(modem);
//
// sensor.on('power_up', console.log);

// gateway.config_get_pan_id('00:13:a2:00:41:07:18:81').then((res) => {
// 	console.log('pan id:');
// 	console.log(res);
// });
// 7e 00 06 09 5b 49 44 7b cd c6
// 7e 00 04 09 5b 49 44 0e
function mac2bytes(mac){
	return mac.split(':').map((v) => parseInt(v, 16));
}
