const events = require("events");
const Queue = require("promise-queue");
module.exports = class WirelessSensor{
	constructor(digi){
		this.mac;
		this.digi = digi;
		this.send = digi.send;
		this._emitter = new events.EventEmitter();
		this.sensor_pool = {};
		this.sensor_types = sensor_types();
		this.queue = new Queue(1);
		this.payloadType = {
             "122": 'power_up',
			 "124": 'config_ack',
			 "125": 'config_error',
             "127": 'sensor_data',
        };

		var that = this;
		function receiver(frame){
			that.parse(frame);
		}
		this.digi.on('receive_packet', receiver);
		this.on('close', () => {
			this.digi._emitter.removeListener('receive_packet', receiver);
		});
	}
	close(cb){
		this._emitter.emit('close');
		this.digi.close();
	}
	parse(frame){
		var type = this.payloadType[frame.data[0]];
		if(typeof this[type] == 'function'){
			var data = this[type](frame.data.slice(1));
			data.type = type;
			data.addr = frame.mac;
			data.original = frame;
			var is_new = typeof this.sensor_pool[frame.mac] == 'undefined';
			var new_mode = is_new;
			var mode = type == 'power_up' ? data.mode : (type == 'sensor_data' ? 'RUN' : 'PGM');
			if(!is_new){
				new_mode = this.sensor_pool[frame.mac].mode != mode;
			};

			this.sensor_pool[frame.mac] = {
				mac: frame.mac,
				type: data.sensor_type,
				nodeId: data.nodeId,
				mode: mode
			};

			if(is_new){
				this._emitter.emit('found_sensor', this.sensor_pool[frame.mac]);
			}
			if(new_mode){
				this._emitter.emit('sensor_mode', this.sensor_pool[frame.mac]);
				this._emitter.emit('sensor_mode-'+frame.mac, this.sensor_pool[frame.mac]);
			}

			this._emitter.emit(type, data);
			this._emitter.emit(type+'-'+data.sensor_type, data);
			this._emitter.emit(type+'-'+frame.mac, data);
		}else{
			this._emitter.emit(type+'-'+frame.mac, {error: 'Bad Payload', error_message: 'Bad payload type:'+type});
		}
	}
	power_up(payload){
		return {
			nodeId: payload[0],
			sensor_type: msbLsb(payload[2], payload[3]),
			mode: String.fromCharCode(...payload.slice(6, 9))
		}
	}
	config_ack(payload){
		return {
			nodeId: payload[0],
			counter: payload[1],
			sensor_type: msbLsb(payload[2], payload[3]),
			data: payload.slice(6)
		}
	}
	config_error(payload){
		var errors = [
			'Unknown',
			'Invalid Command',
			'Sensor Type Mismatch',
			'Node ID Mismatch',
			'Apply change command failed',
			'Invalid API Packet Command Response Received After Apply Change Command',
			'Write command failed',
			'Invalid API Packet Command Response Received After Write Command',
			'Parameter Change Command Failed',
			'Invalid Parameter Change Command Response Received After Write Command',
			'Invalid/Incomplete Packet Received',
			'Unknown',
			'Unknown',
			'Unknown',
			'Unknown',
			'Invalid Parameter for Setup/Saving'
		];
		return {
			nodeId: payload[0],
			sensor_type: msbLsb(payload[2], payload[3]),
			error: payload[6],
			error_message: errors[payload[6]]
		}
	}
	sensor_data(payload){
		var parsed = {
			nodeId: payload[0],
			firmware: payload[1],
			battery: msbLsb(payload[2], payload[3]) * 0.00322,
			counter: payload[4],
			sensor_type: msbLsb(payload[5], payload[6]),
		}
		parsed.sensor_data = this.sensor_types[parsed.sensor_type].parse(payload.slice(8));
		return parsed;
	}
	// parse_sensor_data(data, d){
	// 	var readings = {};
	// 	switch(data.sensor_type){
	// 		case 1:
	// 			readings.humidity = msbLsb(d[0], d[1])/100;
	// 		case 4:
	// 			readings.temperature = (msbLsb(d[2], d[3])/100)*1.8+32;
	// 			break;
	// 		case 2:
	// 			readings.input_1 = d[0];
	// 			readings.input_2 = d[1];
	// 			break;
	// 		case 3:
	// 			readings.input_1 = msbLsb(d[0], d[1]);
	// 			readings.input_2 = msbLsb(d[2], d[3]);
	// 			break;
	// 		case 10:
	// 			readings.lux = d.slice(0, 3).reduce(msbLsb);
	// 			break;
	// 		case 10006:
	// 			for(var i=0;i++;i<4) readings[`channel_${i+1}`] = d.slice((i*2), 1+(i*2)).reduce(msbLsb) / 100;
	// 			break;
	// 		case 10007:
	// 			for(var i=0;i++;i<4) readings[`channel_${i+1}`] = d.slice((i*3), 2+(i*3)).reduce(msbLsb) / 1000;
	// 			break;
	// 		case 10012:
	// 			//relay controller
	// 			readings.relay_1 = d[0];
	// 			readings.relay_2 = d[1];
	// 			readings.input_1 = d[2] ? "On" : "Off";
	// 			readings.input_2 = d[3] ? "On" : "Off";
	// 			break;
	//
	// 	}
	// 	return readings;
	// }

	// config(cmd, mac, node_id, sensor_type, ...data){
	// 	this.config_send(sensor_mac, [247, this.cmds[cmd].get, node_id, sensor_type >> 8, sensor_type & 255]).then((res) => {
	// 		var val;
	// 		var ret = res.data.slice(0, this.cmds[cmd].ret);
	// 		if(this.cmds[cmd].mux){
	// 			if(this.cmds[cmd].mux == 'reduce'){
	// 				val = ret.reduce(this.cmds[cmd].reduce);
	// 			}else{
	// 				val = this.cmds[cmd].mux(res);
	// 			}
	// 		}else{
	// 			val = this.cmds[cmd].ret == 1 ? ret[0] : ret;
	// 		}
	// 		if(data){
	//
	// 		}
	// 	}).catch(reject);
	// }

	config_set_broadcast(sensor_mac){
		return config_set_destination(sensor_mac, "FF:FF");
	}
	config_set_destination(sensor_mac, modem_mac){
		return new Promise((fulfill, reject) => {
			this.config_get_destination(sensor_mac).then((dest) => {
				if(dest != modem_mac){
					var packet = [247, 3, 0, 0, 0];
					var bytes = mac2bytes(modem_mac);
					packet.push(...bytes);
					this.config_send(sensor_mac, packet).then(fulfill).catch(reject);
				}else{
					fulfill();
				}
			}).catch(reject);
		});
	}
	config_set_id_delay(sensor_mac, node_id, delay_s){
		return new Promise((fulfill, reject) => {
			this.config_get_delay(sensor_mac).then((res) => {
				if(res.nodeId != node_id || res.delay != delay_s){
					var packet = [247, 2, 0, 0, 0, node_id];
					var delay_b = int2Bytes(delay_s, 3);
					packet.push(...delay_b);
					this.config_send(sensor_mac, packet).then(fulfill).catch(reject);
				}else{
					fulfill();
				}
			}).catch(reject);
		});
	}
	config_set_power(sensor_mac, pwr){
		return new Promise((fulfill, reject) => {
			this.config_get_power(sensor_mac).then((power) => {
				if(power != pwr){
					var packet = [247, 4, 0, 0, 0];
					this.config_send(sensor_mac, packet).then(fulfill).catch(reject);
				}else{
					fulfill();
				}
			}).catch(reject);
		});
	}
	config_set_pan_id(sensor_mac, pan_id){
		return new Promise((fulfill, reject) => {
			this.config_get_pan_id(sensor_mac).then((pan) => {
				if(pan != pan_id){
					var packet = [247, 5, 0, 0, 0];
					var pan_b = int2Bytes(pan_id, 2);
					//packet.push(...int2Bytes(pan_id));
					packet.push(pan_id >> 8, pan_id & 255)
					this.config_send(sensor_mac, packet).then(fulfill).catch(reject);
				}else{
					fulfill();
				}
			}).catch(reject);
		});
	}
	config_set_retries(sensor_mac, retries){

		return new Promise((fulfill, reject) => {
			this.config_get_retries(sensor_mac).then((_retries) => {
				if(retries != _retries){
					var packet = [247, 6, 0, 0, 0, retries];
					this.config_send(sensor_mac, packet).then(fulfill).catch(reject);
				}else{
					fulfill();
				}
			}).catch(reject);
		});
	}
	config_get_delay(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [247, 21, 0, 0, 0]).then((res) => {
				fulfill({
					nodeId: res.nodeId,
					delay: res.data.slice(0, 3).reduce(msbLsb)
				});
			}).catch(reject);
		});
	}
	config_get_power(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [247, 22, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_retries(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [247, 23, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_destination(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [247, 24, 0, 0, 0]).then((res) => {
				fulfill(res.data.slice(0, 4));
			}).catch(reject);
		});
	}
	config_get_pan_id(sensor_mac, node_id, sensor_type){

		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [247, 25, 0, 0, 1]).then((res) => {
				fulfill(res.data.slice(0, 2).reduce(msbLsb));
			}).catch(reject);
		});
	}
	config_enable_encryption(sensor_mac){
		return this.config_send(sensor_mac, [242, 1, 0, 0, 0]);
	}
	config_disable_encryption(sensor_mac){
		return this.config_send(sensor_mac, [242, 2, 0, 0, 0]);
	}
	config_set_encryption(sensor_mac, ...key){
		if(key[0].constructor == Array) key = key[0];
		var packet = [242, 1];
		packet.push(...key);
		return this.config_send(sensor_mac, packet);
	}

	config_send(sensor_mac, data, opts){
		var that = this;
		return new Promise((fulfill, reject) => {
			this.queue.add(() => {
				return new Promise((f, r) => {
					that._emitter.once('config_ack-'+sensor_mac, (packet) => {
						that._emitter.removeAllListeners('config_error-'+sensor_mac);
						fulfill(packet);
						f();
					});
					that._emitter.once('config_error-'+sensor_mac, (packet) => {
						that._emitter.removeAllListeners('config_ack-'+sensor_mac);
						reject(packet);
						f();
					});
					that.send.transmit_request(mac2bytes(sensor_mac), data, opts).then().catch(reject).then();
				})
			})
		})
	}
	on(e,cb){this._emitter.on(e,cb);}
}
function sensor_types(){
	var types = {
		"1": {
			name: "Temperature/Humidity",
			parse: (d) => {
				return {
					humidity: msbLsb(d[0], d[1])/100,
					temperature: (msbLsb(d[2], d[3])/100)
				}
			}
		},
		"2": {
			name: "2 Channel Push Notification",
			parse: (d) => {
				return {
					input_1: d[0],
					input_2: d[1]
				}
			}
		},
		"3": {
			name: "ADC",
			parse: (d) => {
				return {
					input_1: msbLsb(d[0], d[1]),
					input_2: msbLsb(d[2], d[3])
				}
			}
		},
		"4": {
			name: "Thermocouple",
			parse: (d) => {
				return {
					temperature: d.slice(0, 4).reduce(msbLsb)/100,
				}
			}
		},
		"5": {
			name: "Gyro/Magneto/Temperature",
			parse: (d) => {
				return {
					accel_x: d.slice(0, 3).reduce(msbLsb)/100,
					accel_y: d.slice(3, 6).reduce(msbLsb)/100,
					accel_z: d.slice(6, 9).reduce(msbLsb)/100,
					magneto_x: d.slice(9, 12).reduce(msbLsb)/100,
					magneto_y: d.slice(12, 15).reduce(msbLsb)/100,
					magneto_z: d.slice(15, 18).reduce(msbLsb)/100,
					gyro_x: d.slice(18, 21).reduce(msbLsb),
					gyro_y: d.slice(21, 24).reduce(msbLsb),
					gyro_z: d.slice(24, 27).reduce(msbLsb),
					temperature: msbLsb(d[2], d[3])
				}
			}
		},
		"6": {
			name: "Temperature/Barometeric Pressure",
			parse: (d) => {
				return {
					temperature: msbLsb(d[0], d[1]),
					absolute_pressure: msbLsb(d[2], d[3])/1000,
					relative_pressure: msbLsb(d[4], d[5])/1000,
					altitude_change: msbLsb(d[6], d[7])/100
				}
			}
		},
		"8": {
			name: "Vibration",
			parse: (d) => {
				return {
					rms_x: d.slice(0, 3).reduce(msbLsb)/100,
					rms_y: d.slice(3, 6).reduce(msbLsb)/100,
					rms_z: d.slice(6, 9).reduce(msbLsb)/100,
					max_x: d.slice(9, 12).reduce(msbLsb)/100,
					max_y: d.slice(12, 15).reduce(msbLsb)/100,
					max_z: d.slice(15, 18).reduce(msbLsb)/100,
					min_x: d.slice(18, 21).reduce(msbLsb),
					min_y: d.slice(21, 24).reduce(msbLsb),
					min_z: d.slice(24, 27).reduce(msbLsb),
					temperature: msbLsb(d[2], d[3])
				}
			}
		},
		"9": {
			name: "Proximity",
			parse: (d) => {
				return {
					proximity: msbLsb(d[0], d[1]),
					lux: msbLsb(d[2], d[3]) * .25
				}
			}
		},
		"10": {
			name: "Light",
			parse: (d) => {
				return {
					lux: d.slice(0, 3).reduce(msbLsb)
				}
			}
		},
		"23": {
			name: "One Channel Counter",
			parse: (d) => {
				return {
					counts: d.slice(0, 4).reduce(msbLsb)
				}
			}
		},
		"24": {
			name: "Two Channel Counter",
			parse: (d) => {
				return {
					counts_1: msbLsb(d[0], d[1]),
					counts_2: msbLsb(d[2], d[3])
				}
			}
		},
		"25": {
			name: "7 Channel Push Notification",
			parse: (d) => {
				return {
					input_1: d[0] & 1 ? 1 : 0,
					input_2: d[0] & 2 ? 1 : 0,
					input_3: d[0] & 4 ? 1 : 0,
					input_4: d[0] & 8 ? 1 : 0,
					input_5: d[0] & 16 ? 1 : 0,
					input_6: d[0] & 32 ? 1 : 0,
					input_7: d[0] & 64 ? 1 : 0,
					adc_1: msblsb(d[1], d[2]),
					adc_2: msblsb(d[3], d[4]),
				}
			}
		},
		"10006":{
			name: "4-Channel 4-20 mA Input",
			parse: (d) => {
				var readings = {};
				for(var i=0;i++;i<4) readings[`channel_${i+1}`] = d.slice((i*2), 1+(i*2)).reduce(msbLsb) / 100;
				return readings;
			}
		},
		"10007":{
			name: "4-Channel Current Monitor",
			parse: (d) => {
				var readings = {};
				for(var i=0;i++;i<4) readings[`channel_${i+1}`] = d.slice((i*3), 2+(i*3)).reduce(msbLsb) / 1000;
				return readings;
			}
		},
		"10012":{
			name: "2-Relay + 2-Input",
			parse: (d) => {
				return {
					relay_1: d[0],
					relay_2: d[1],
					input_1: d[2] ? "On" : "Off",
					input_2: d[3] ? "On" : "Off"
				}
			}
		}
	}
	return types;
}
// this.cmds = {
// 	destination: {
// 		set: 3,
// 		prep: mac2bytes,
// 		get: 24,
// 		ret: 4,
// 		reduce: byte2mac
// 	},
// 	id_delay: {
// 		set: 2,
// 		prep: (v) => {
//
// 		},
// 		get: 21,
// 		ret: 3,
// 		mux: function(res){
// 			return {
// 				nodeId: res.nodeId,
// 				delay: res.data.slice(0, 3).reduce(msbLsb)
// 			}
// 		}
// 		equal: (v1, v2){
// 			return v1[0] == v2.nodeId && v1[]
// 		}
// 		reduce: msbLsb
// 	},
// 	power: {
// 		set: 4,
// 		get: 22,
// 		ret: 1
// 	},
// 	pan_id: {
// 		set: 5,
// 		prep: int2Bytes,
// 		get: 25,
// 		ret: 2,
// 		reduce: msbLsb
// 	},
// 	retries: {
// 		set: 6,
// 		get: 23,
// 		ret: 1
// 	}
// }
function mac2bytes(mac){
	return mac.split(':').map((v) => parseInt(v, 16));
}
function msbLsb(m,l){return (m<<8)+l;}
function byte2mac(h,c,i){return (i==1?h.toHex():h)+':'+c.toHex();}
function int2Bytes(i, l){
	if(!l) l=1;
	var ret = [];
	if(i > 0){
		while(i > 0){
			ret.unshift(i & 255);
			i = i >> 8;
		}
	}
	if(ret.length < l){
		while(ret.length < l) ret.unshift(0);
	}
	return ret;
}
