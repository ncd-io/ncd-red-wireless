const wireless = require("./index.js");
const comms = require('ncd-red-comm');
const sp = require('serialport');
const Queue = require("promise-queue");

module.exports = function(RED) {
	var gateway_pool = {};

	function NcdGatewayConfig(config){
		RED.nodes.createNode(this,config);
        this.port = config.port;
		this.baudRate = parseInt(config.baudRate);
		this.sensor_pool = [];
		if(typeof gateway_pool[this.port] != 'undefined'){
			if(this.baudRate != gateway_pool[this.port].digi.serial.baudRate){
				gateway_pool[this.port].digi.serial.update({baudRate: this.baudRate}).then().catch(console.log);
			}
		}else{
			var serial = new comms.NcdSerial(this.port, this.baudRate);
			serial.on('error', (err) => {
				console.log(err);
			})
			var modem = new wireless.Modem(serial);
			gateway_pool[this.port] = new wireless.Gateway(modem);
		}
		this.gateway = gateway_pool[this.port];
		var node = this;
		this.on('close', () => {
			node.gateway._emitter.removeAllListeners('sensor_data');
			node.gateway.digi.serial.close();
		});
		node.gateway.digi.send.at_command("SL").then((res) => {
			node.gateway.addr = res.data.reduce((m,l) => (m<<8)+l).toString(16);
		}).catch((err) => {
		});
		node.check_mode = function(cb){
			node.gateway.digi.send.at_command("ID").then((res) => {
				var pan_id = (res.data[0] << 8) | res.data[1];
				console.log(pan_id);
				if(pan_id == 0x7BCD && parseInt(config.pan_id, 16) != 0x7BCD){
					node.is_config = 1;
				}else{
					node.gateway.pan_id = pan_id;
					node.is_config = 0;
				}
				if(cb) cb(node.is_config);
			}).catch((err) => {
				console.log(err);
				node.is_config = 2;
				if(cb) cb(node.is_config);
			});
		}
		node.check_mode((mode) => {
			var pan_id = parseInt(config.pan_id, 16);
			if(!mode && node.gateway.pan_id != pan_id){
				node.gateway.digi.send.at_command("ID", [pan_id >> 8, pan_id & 255]).then((res) => {
					node.gateway.pan_id = pan_id;
					console.log(pan_id);
				}).catch((err) => {
					console.log(err);
				});
			}
		});
	}

	RED.nodes.registerType("ncd-gateway-config", NcdGatewayConfig);

	function NcdGatewayNode(config){
		RED.nodes.createNode(this,config);
		this._gateway_node = RED.nodes.getNode(config.connection);
		this.gateway = this._gateway_node.gateway;

		var node = this;
		node.is_config = false;
		var statuses =[
			{fill:"green",shape:"dot",text:"Ready"},
			{fill:"yellow",shape:"ring",text:"Configuring"},
			{fill:"red",shape:"dot",text:"Failed to Connect"}
		]
		node.set_status = function(){
			node.status(statuses[node._gateway_node.is_config]);
		}
		node.gateway.on('sensor_data', (d) => node.send({topic: 'sensor_data', payload: d}));
		// node.on('close', () => {
		// 	node.gateway._emitter.removeAllListeners('sensor_data');
		// });
		node.set_status();
	}
	RED.nodes.registerType("ncd-gateway-node", NcdGatewayNode);


	function NcdWirelessNode(config){
		RED.nodes.createNode(this,config);
		this.gateway = RED.nodes.getNode(config.connection).gateway;
		var dedicated_config = false;
		this.config_gateway = this.gateway;
		if(config.config_gateway){
			this.config_gateway = RED.nodes.getNode(config.config_gateway).gateway;
			dedicated_config = true;
		}
		this.queue = new Queue(1);
		var node = this;
		var modes = {
			PGM: {fill:"red",shape:"dot",text:"Config Mode"},
			PGM_NOW: {fill:"red",shape:"dot",text:"Configuring..."},
			READY: {fill: "green", shape: "ring", text:"Config Complete"},
			RUN: {fill:"green",shape:"dot",text:"Running"},
		}
		var events = {};
		var pgm_events = {};
		this.gtw_on = (event, cb) => {
			events[event] = cb;
			this.gateway.on(event, cb);
		}
		this.pgm_on = (event, cb) => {
			events[event] = cb;
			this.config_gateway.on(event, cb);
		}
		function _delay(time){
			node.queue.add(() => {
				return new Promise((fulfill, reject) => {
					setTimeout(fulfill, time);
				});
			});
		}

		function _config(mac){
			_delay(1000);
			node.queue.add(() => {
				node.status(modes.PGM_NOW);
				var dest = config.destination;
				if(!dest) dest = node.gateway.addr;
				node.config_gateway.config_set_destination(mac, parseInt(dest, 16));
			});
			node.queue.add(() => {
				node.config_gateway.config_set_id_delay(mac, parseInt(config.node_id), parseInt(config.delay));
			});
			node.queue.add(() => {
				node.config_gateway.config_set_power(mac, parseInt(config.power));
			});
			node.queue.add(() => {
				node.config_gateway.config_set_retries(mac, parseInt(config.retries));
			});
			node.queue.add(() => {
				node.config_gateway.config_set_pan_id(mac, parseInt(config.pan_id, 16));
			});
			node.queue.add(() => {
				return new Promise((fulfill, reject) => {
					node.status(modes.READY);
					fulfill();
				});
			});
		}
		if(config.addr){
			RED.nodes.getNode(config.connection).sensor_pool.push(config.addr);
			this.gtw_on('sensor_data-'+config.addr, (data) => {
				node.status(modes.RUN);
				node.send({
					topic: 'sensor_data',
					data: data,
					payload: data.sensor_data
				});
			});
			this.pgm_on('sensor_mode-'+config.addr, (sensor) => {
				node.status(modes[sensor.mode]);
				if(config.auto_config && sensor.mode == "PGM") _config(sensor.mac);
			});
		}else if(config.sensor_type){
			this.gtw_on('sensor_data-'+config.sensor_type, (data) => {
				node.status(modes.RUN);
				node.send({
					topic: 'sensor_data',
					data: data,
					payload: data.sensor_data
				});
			});

			// this.gateway.on('sensor_mode', (sensor) => {
			// 	if(sensor.sensor_type == config.sensor_type){
			// 		node.status(modes[sensor.mode]);
			// 	}
			// });
			this.pgm_on('sensor_mode', (sensor) => {
				if(sensor.type == config.sensor_type){
					node.status(modes[sensor.mode]);
					if(config.auto_config && sensor.mode == 'PGM'){
						_config(sensor.mac);
					}
				}
			});
		}
		this.on('close', () => {
			for(var e in events){
				node.gateway._emitter.removeAllListeners(e);
			}
			for(var p in pgm_events){
				node.config_gateway._emitter.removeAllListeners(p);
			}
		});
	}
	RED.nodes.registerType("ncd-wireless-node", NcdWirelessNode);

	RED.httpAdmin.post("/ncd/wireless/gateway/config/:id", RED.auth.needsPermission("serial.read"), function(req,res) {
        var node = RED.nodes.getNode(req.params.id);
        if (node != null) {
            try {
				var pan = node._gateway_node.is_config ? [0x7f, 0xff] : [0x7b, 0xcd];
				var msgs = [
					'In listening mode',
					'In config mode',
					'Failed to connect'
				]
				console.log('updating pan to'+((pan[0] << 8) + pan[1]));
				node.gateway.digi.send.at_command("ID", pan).then().catch().then(() => {
					node._gateway_node.check_mode((m) => {
						node.set_status();
						res.send(msgs[m])
					});
				});
            } catch(err) {
                res.sendStatus(500);
                node.error(RED._("inject.failed",{error:err.toString()}));
            }
        } else {
            res.sendStatus(404);
        }
    });

	RED.httpAdmin.get("/ncd/wireless/modems/list", RED.auth.needsPermission('serial.read'), function(req,res) {
		getSerialDevices(true, res);
	});
	RED.httpAdmin.get("/ncd/wireless/modem/info/:port/:baudRate", RED.auth.needsPermission('serial.read'), function(req,res) {
		var port = decodeURIComponent(req.params.port);
		if(typeof gateway_pool[port] == 'undefined'){
			var serial = new comms.NcdSerial(port, parseInt(req.params.baudRate));
			var modem = new wireless.Modem(serial);
			gateway_pool[port] = new wireless.Gateway(modem);
			serial.on('ready', ()=>{
				serial._emitter.removeAllListeners('ready');
				modem.send.at_command("ID").then((bytes) => {
					pan_id = (bytes.data[0] << 8) | bytes.data[1];
					serial.close();
					res.json({pan_id: pan_id.toString(16)});
				}).catch((err) => {
					serial.close();
					res.json(false);
				});
			});
		}else{
			res.json({pan_id: gateway_pool[port].pan_id.toString(16)});
		}
	});
	RED.httpAdmin.get("/ncd/wireless/sensors/list/:id", RED.auth.needsPermission('serial.read'), function(req,res) {
		var node = RED.nodes.getNode(req.params.id);
        if (node != null) {
            try {
				var sensors = [];
				for(var i in node.gateway.sensor_pool){
					if(node.sensor_pool.indexOf(node.gateway.sensor_pool[i].mac) > -1) continue;
					sensors.push(node.gateway.sensor_pool[i])
				}
				res.json(sensors);
            } catch(err) {
                res.sendStatus(500);
                node.error(RED._("inject.failed",{error:err.toString()}));
            }
        } else {
            res.sendStatus(404);
        }
	});

}
function getSerialDevices(ftdi, res){
	var busses = [];
	sp.list().then((ports) => {
		ports.forEach((p) => {
			busses.push(p.comName);
		});
	}).catch((err) => {

	}).then(() => {
		res.json(busses);
	});
}
