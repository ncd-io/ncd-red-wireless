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

		if(typeof gateway_pool[this.port] == 'undefined'){
			var serial = new comms.NcdSerial(this.port, this.baudRate);
			serial.on('error', (err) => {
				console.log(err);
			});
			var modem = new wireless.Modem(serial);
			gateway_pool[this.port] = new wireless.Gateway(modem);
		}
		this.gateway = gateway_pool[this.port];
		this.gateway.digi.report_rssi = config.rssi;

		var node = this;
		this.on('close', (removed, done) => {
			if(removed){
				node.gateway._emitter.removeAllListeners('sensor_data');
				node.gateway.digi.serial.close(() => {
					delete gateway_pool[this.port];
					done();
				});
			}else{
				done();
			}
		});

		node.check_mode = function(cb){
			node.gateway.digi.send.at_command("ID").then((res) => {
				var pan_id = (res.data[0] << 8) | res.data[1];
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
		};
		node.gateway.digi.serial.on('ready', () => {
			node.check_mode((mode) => {
				var pan_id = parseInt(config.pan_id, 16);
				if(!mode && node.gateway.pan_id != pan_id){
					node.gateway.digi.send.at_command("ID", [pan_id >> 8, pan_id & 255]).then((res) => {
						node.gateway.pan_id = pan_id;
					}).catch((err) => {
						console.log(err);
					});
				}
			});
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
		];
		node.set_status = function(){
			node.status(statuses[node._gateway_node.is_config]);
		};
		node.gateway.on('sensor_data', (d) => node.send({topic: 'sensor_data', payload: d}));

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
			PGM_ERR: {fill:"red", shape:"ring", text:"Config Error"},
			RUN: {fill:"green",shape:"dot",text:"Running"}
		};
		var events = {};
		var pgm_events = {};
		this.gtw_on = (event, cb) => {
			events[event] = cb;
			this.gateway.on(event, cb);
		};
		this.pgm_on = (event, cb) => {
			events[event] = cb;
			this.config_gateway.on(event, cb);
		};
		function _config(sensor){
			return new Promise((top_fulfill, top_reject) => {

				var success = {};
				setTimeout(() => {
					var tout = setTimeout(() => {
						node.status(modes.PGM_ERR);
						node.send({topic: 'Config Results', payload: success});
					}, 60000);
					node.status(modes.PGM_NOW);
					if(parseInt(config.sensor_type) >= 10000){
						if(sensor) return;
						var dest = parseInt(config.destination, 16);
						if(dest == 65535){
							dest = [0,0,0,0,0,0,255,255];
						}else{
							dest = [0, 0x13, 0xa2, 0, ...int2Bytes(dest, 4)];
						}
						var promises = {
							destination: node.gateway.config_powered_device(config.addr, 'destination', ...dest),
							network_id: node.gateway.config_powered_device(config.addr, 'network_id', ...int2Bytes(parseInt(config.pan_id, 16), 2)),
							power: node.gateway.config_powered_device(config.addr, 'power', parseInt(config.power)),
							retries: node.gateway.config_powered_device(config.addr, 'retries', parseInt(config.retries)),
							node_id: node.gateway.config_powered_device(config.addr, 'node_id', parseInt(config.node_id)),
							delay: node.gateway.config_powered_device(config.addr, 'delay', ...int2Bytes(parseInt(config.delay), 3))
						};
					}else{
						var mac = sensor.mac;
						var promises = {
							destination: node.config_gateway.config_set_destination(mac, parseInt(config.destination, 16)),
							id_and_delay: node.config_gateway.config_set_id_delay(mac, parseInt(config.node_id), parseInt(config.delay)),
							power: node.config_gateway.config_set_power(mac, parseInt(config.power)),
							retries: node.config_gateway.config_set_retries(mac, parseInt(config.retries)),
							network_id: node.config_gateway.config_set_pan_id(mac, parseInt(config.pan_id, 16))
						};
						var change_detection = [13, 10, 3];
						if(change_detection.indexOf(sensor.type) > -1){
							promises.change_detection = node.config_gateway.config_set_change_detection(mac, config.change_enabled ? 1 : 0, parseInt(config.change_pr), parseInt(config.change_interval));
						}
						switch(sensor.type){
							case 13:
								var cali = parseFloat(config.cm_calibration);
								if(cali == 0) break;
								promises.calibration = node.config_gateway.config_set_cm_calibration(mac, cali);
								break;
							case 24:
								var interr = parseInt(config.activ_interr_x) | parseInt(config.activ_interr_y) | parseInt(config.activ_interr_z) | parseInt(config.activ_interr_op);
								promises.activity_interrupt = node.config_gateway.config_set_activ_interr(mac, interr);
							case 7:
								promises.acceleration_range = node.config_gateway.config_set_impact_accel(mac, parseInt(config.impact_accel));
								promises.data_rate = node.config_gateway.config_set_impact_data_rate(mac, parseInt(config.impact_data_rate));
								promises.impact_threshold = node.config_gateway.config_set_impact_threshold(mac, parseInt(config.impact_threshold));
								promises.impact_duration = node.config_gateway.config_set_impact_duration(mac, parseInt(config.impact_duration));
								break;
							case 6:
								promises.altitude = node.config_gateway.config_set_bp_altitude(mac, parseInt(config.bp_altitude));
								promises.pressure = node.config_gateway.config_set_bp_pressure(mac, parseInt(config.bp_pressure));
								promises.temp_precision = node.config_gateway.config_set_bp_temp_precision(mac, parseInt(config.bp_temp_prec));
								promises.pressure_precision = node.config_gateway.config_set_bp_press_precision(mac, parseInt(config.bp_press_prec));
								break;
							case 5:
								promises.acceleration_range = node.config_gateway.config_set_amgt_accel(mac, parseInt(config.amgt_accel));
								promises.magnetometer_gain = node.config_gateway.config_set_amgt_magnet(mac, parseInt(config.amgt_mag));
								promises.gyroscope_scale = node.config_gateway.config_set_amgt_gyro(mac, parseInt(config.amgt_gyro));
								break;
						}
					}
					promises.finish = new Promise((fulfill, reject) => {
						node.config_gateway.queue.add(() => {
							return new Promise((f, r) => {
								clearTimeout(tout);
								node.status(modes.READY);
								fulfill();
								f();
							});
						});
					});
					for(var i in promises){
						(function(name){
							promises[name].then((f) => {
								if(name != 'finish') success[name] = true;
								else{
									node.send({topic: 'Config Results', payload: success});
									top_fulfill(success);
								}
							}).catch((err) => {
								success[name] = err;
							});
						})(i);
					}
				}, 1000);
			});
		}
		node._sensor_config = _config;
		if(config.addr){
			config.addr = config.addr.toLowerCase();
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
				if(config.auto_config && sensor.mode == "PGM"){
					_config(sensor);
				}
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

			this.pgm_on('sensor_mode', (sensor) => {
				if(sensor.type == config.sensor_type){
					node.status(modes[sensor.mode]);
					if(config.auto_config && sensor.mode == 'PGM'){
						_config(sensor);
					}
				}
			});
		}
		this.on('input', (msg) => {
			if(msg.topic == 'config'){
				_config();
			}else{
				node.gateway.send_control(config.sensor_type, config.addr, msg).then((m) => {
					//console.log("complete", m);
				}).catch((err) => {
					console.log("error", err);
				});
			}
		});
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
				//console.log(node);
				var _pan = node._gateway_node.gateway.pan_id;
				var pan = node._gateway_node.is_config ? [_pan >> 8, _pan & 255] : [0x7b, 0xcd];
				var msgs = [
					'In listening mode',
					'In config mode',
					'Failed to connect'
				];
				node.gateway.digi.send.at_command("ID", pan).then().catch().then(() => {
					node._gateway_node.check_mode((m) => {
						node.set_status();
						res.send(msgs[m]);
					});
				});
            } catch(err) {
                res.sendStatus(500);
                node.error(RED._("gateway.update failed",{error:err.toString()}));
            }
        } else {
            res.sendStatus(404);
        }
    });

	RED.httpAdmin.get("/ncd/wireless/sensors/configure/:id", RED.auth.needsPermission('serial.read'), function(req,res) {
		var node = RED.nodes.getNode(req.params.id);
        if (node != null) {
			node._sensor_config().then((s) => {
				res.json(s);
			});
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
					sensors.push(node.gateway.sensor_pool[i]);
				}
				res.json(sensors);
            } catch(err) {
                res.sendStatus(500);
                node.error(RED._("sensor_list.failed",{error:err.toString()}));
            }
        } else {
            res.json({});
        }
	});
};
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
function chunkString1(str, len) {
	var _length = str.length,
		_size = Math.ceil(_length/len),
    	_ret  = [];
	for(var _i=0; _i<_length; _i+=len) {
    	_ret.push(str.substring(_i, _i + len));
	}
	return _ret;
}
function int2Bytes(i, l){
	var bits = i.toString(2);
	if(bits.length % 8) bits = ('00000000' + bits).substr(bits.length % 8);
	var bytes = chunkString1(bits, 8).map((v) => parseInt(v, 2));
	if(bytes.length < l){
		while(bytes.length < l){
			bytes.unshift(0);
		}
	}
	return bytes;
}
