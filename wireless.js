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
		if(typeof gateway_pool[this.bus] != 'undefined'){
			if(this.baudRate != gateway_pool[this.bus].digi.serial.baudRate){
				gateway_pool[this.bus].digi.serial.update({baudRate: this.baudRate}).then().catch(console.log);
			}
		}else{
			var serial = new comms.NcdSerial(this.port, this.baudRate);
			var modem = new wireless.Modem(serial);
			gateway_pool[this.bus] = new wireless.Gateway(modem)
		}
		this.gateway = gateway_pool[this.bus];
	}
	RED.nodes.registerType("ncd-gateway-config", NcdGatewayConfig);

	function NcdGatewayNode(config){
		RED.nodes.createNode(this,config);
		this.gateway = RED.nodes.getNode(config.connection).gateway;

		var node = this;
		node.is_config = false;
		node.check_mode = function(cb){
			node.gateway.digi.send.at_command("ID").then((res) => {
				var pan_id = (res.data[0] << 8) | res.data[1];
				if(pan_id == 0x7BCD){
					node.is_config = true;
					node.status({fill:"yellow",shape:"ring",text:"Configuring"});
				}else{
					node.status({fill:"green",shape:"dot",text:"Ready"});
					node.is_config = false;
				}
				if(cb) cb(node.is_config ? "in configuration mode" : "in listening mode");
			}).catch(() => {
				node.status({fill:"red",shape:"dot",text:"Failed to Connect"});
				if(cb) cb("unable to connect");
			});
		}
		node.gateway.on('sensor_data', (d) => node.send({topic: 'sensor_data', payload: d}));
		node.on('close', () => {
			node.gateway._emitter.removeAllListeners('sensor_data');
		});
		node.check_mode();
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
			RUN: {fill:"green",shape:"dot",text:"Running"},
			READY: {fill: "green", shape: "ring", text:"Config Complete"}
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

		function _config(mac){
			node.queue.add(() => {
				return new Promise((fulfill, reject) => {
					setTimeout(fulfill, 500);
				});
			});
			// node.queue.add(() => {
			// 	return node.gateway.config_set_destination(mac, config.destination);
			// });
			node.queue.add(() => {
				return node.gateway.config_set_id_delay(mac, parseInt(config.node_id), parseInt(config.delay));
			});
			// node.queue.add(() => {
			// 	return node.gateway.config_set_power(mac, config.power);
			// });
			// node.queue.add(() => {
			// 	return node.gateway.config_set_retries(mac, config.retries);
			// });
			// node.queue.add(() => {
			// 	return node.gateway.config_set_pan_id(mac, config.pan_id);
			// });
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
				if(sensor.sensor_type == config.sensor_type){
					node.status(modes[sensor.mode]);
					if(config.auto_config) _config(sensor.mac);
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
				var pan = node.is_config ? [0x7f, 0xff] : [0x7b, 0xcd];
				node.gateway.digi.send.at_command("ID", pan).then().catch().then(() => {
					node.check_mode((m) => res.send(m));
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
