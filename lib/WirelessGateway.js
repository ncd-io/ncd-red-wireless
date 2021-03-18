const events = require('events');
const Queue = require('promise-queue');
module.exports = class WirelessSensor{
	constructor(digi){
		this.mac;
		this.digi = digi;
		this.send = digi.send;
		this._emitter = new events.EventEmitter();
		this.sensor_pool = {};
		this.sensor_types = sensor_types(this);
		this.queue = new Queue(1);
		this.payloadType = {
			'122': 'power_up',
			'124': 'config_ack',
			'125': 'config_error',
			'127': 'sensor_data'
		};

		var that = this;
		function receiver(frame){
			that.parse(frame);
		}
		this.digi.on('receive_packet', receiver);
		this.on('close', () => {
			//console.log('removing listener');
			this.digi._emitter.removeListener('receive_packet', receiver);
		});
	}
	send_control(type, mac, msg){
		if(this.sensor_types[type] && typeof this.sensor_types[type].control != 'undefined'){
			return this.control_send(mac, [249, ...this.sensor_types[type].control(msg)]);
		}else{
			return new Promise((f,r)=>{r('Unknown sensor type');});
		}
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
			data.received = Date.now();
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
				mode: mode,
				lastHeard: data.received
			};
			var that = this;

			if(is_new){
				that._emitter.emit('found_sensor', that.sensor_pool[frame.mac]);
			}
			if(new_mode){
				that._emitter.emit('sensor_mode', that.sensor_pool[frame.mac]);
				that._emitter.emit('sensor_mode-'+frame.mac, that.sensor_pool[frame.mac]);
			}

			var send_events = function(){
				that._emitter.emit(type, data);
				that._emitter.emit(type+'-'+data.sensor_type, data);
				that._emitter.emit(type+'-'+frame.mac, data);
			};
			if(typeof frame.rssi == 'undefined') send_events();
			else frame.rssi.then((v) => {
				data.rssi = v.data[0];
				send_events();
			}).catch(console.log);
		}else{
			this._emitter.emit(type+'-'+frame.mac, {error: 'Bad Payload', error_message: 'Bad payload type:'+type});
		}
	}
	power_up(payload){
		return {
			nodeId: payload[0],
			sensor_type: msbLsb(payload[2], payload[3]),
			mode: String.fromCharCode(...payload.slice(6, 9))
		};
	}
	config_ack(payload){
		return {
			nodeId: payload[0],
			counter: payload[1],
			sensor_type: msbLsb(payload[2], payload[3]),
			data: payload.slice(6)
		};
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
			error_message: errors[payload[6]],
			last_sent: this.digi.lastSent
		};
	}
	sensor_data(payload){
		var parsed = {
			nodeId: payload[0],
			firmware: payload[1],
			battery: msbLsb(payload[2], payload[3]) * 0.00322,
			counter: payload[4],
			sensor_type: msbLsb(payload[5], payload[6]),
		};

		if(typeof this.sensor_types[parsed.sensor_type] == 'undefined'){
			parsed.sensor_data = {
				type: 'unknown',
				data: payload.slice(8)
			};
		}else{
			parsed.sensor_data = this.sensor_types[parsed.sensor_type].parse(payload.slice(8), payload);
			parsed.sensor_name = this.sensor_types[parsed.sensor_type].name;
		}
		return parsed;
	}

	config_set_broadcast(sensor_mac){
		return config_set_destination(sensor_mac, 0x0000FFFF);
	}
	config_set_destination(sensor_mac, modem_mac){
		var packet = [247, 3, 0, 0, 0];
		var bytes = int2Bytes(modem_mac, 4);
		packet.push(...bytes);
		return this.config_send(sensor_mac, packet);
	}
	config_set_id_delay(sensor_mac, node_id, delay_s){
		var packet = [247, 2, 0, 0, 0, node_id];
		var delay_b = int2Bytes(delay_s, 3);
		packet.push(...delay_b);
		return this.config_send(sensor_mac, packet);
	}
	config_set_power(sensor_mac, pwr){
		var packet = [247, 4, 0, 0, 0, pwr];
		return this.config_send(sensor_mac, packet);
	}
	config_set_pan_id(sensor_mac, pan_id){
		var packet = [247, 5, 0, 0, 0];
		packet.push(...int2Bytes(pan_id, 2));
		return this.config_send(sensor_mac, packet);
	}
	config_set_retries(sensor_mac, retries){
		var packet = [247, 6, 0, 0, 0, retries];
		return this.config_send(sensor_mac, packet);
	}
	config_set_change_detection(sensor_mac, enabled, perc, interval){
		if(!perc) perc = 0;
		if(!interval) interval = 0;
		var packet = [247, 7, 0, 0, 0, enabled, perc, interval >> 16, (interval >> 8) & 255, interval & 255];
		return this.config_send(sensor_mac, packet);
	}
	config_set_cm_calibration(sensor_mac, calib){
		var cal = parseInt(calib * 100);
		var packet = [244, 1, 0, 0, 0, cal >> 8, cal & 255];
		return this.config_send(sensor_mac, packet);
	}
	config_set_bp_altitude(sensor_mac, alt){
		var packet = [244, 1, 0, 0, 0, alt >> 8, alt & 255];
		return this.config_send(sensor_mac, packet);
	}
	config_set_bp_pressure(sensor_mac, press){
		var packet = [244, 4, 0, 0, 0, press >> 8, press & 255];
		return this.config_send(sensor_mac, packet);
	}
	config_set_bp_temp_precision(sensor_mac, prec){
		var packet = [244, 2, 0, 0, 0, prec];
		return this.config_send(sensor_mac, packet);
	}
	config_set_bp_press_precision(sensor_mac, prec){
		var packet = [244, 3, 0, 0, 0, prec];
		return this.config_send(sensor_mac, packet);
	}
	config_set_amgt_accel(sensor_mac, range){
		var packet = [244, 1, 0, 0, 0, range];
		return this.config_send(sensor_mac, packet);
	}
	config_set_amgt_magnet(sensor_mac, gain){
		var packet = [244, 2, 0, 0, 0, gain];
		return this.config_send(sensor_mac, packet);
	}
	config_set_amgt_gyro(sensor_mac, scale){
		var packet = [244, 3, 0, 0, 0, scale];
		return this.config_send(sensor_mac, packet);
	}
	config_set_impact_accel(sensor_mac, range){
		var packet = [244, 1, 0, 0, 0, range];
		return this.config_send(sensor_mac, packet);
	}
	config_set_impact_data_rate(sensor_mac, rate){
		var packet = [244, 2, 0, 0, 0, rate];
		return this.config_send(sensor_mac, packet);
	}
	config_set_impact_threshold(sensor_mac, threshold){
		var packet = [244, 3, 0, 0, 0, threshold];
		return this.config_send(sensor_mac, packet);
	}
	config_set_impact_duration(sensor_mac, duration){
		var packet = [244, 4, 0, 0, 0, duration];
		return this.config_send(sensor_mac, packet);
	}
	config_set_filtering(sensor_mac, enable){
		var packet = [244, 2, 0, 0, 0, enable];
		return this.config_send(sensor_mac, packet);
	}
	config_set_data_rate(sensor_mac, data_rate){
		var packet = [244, 3, 0, 0, 0, data_rate];
		return this.config_send(sensor_mac, packet);
	}
	config_set_time_series(sensor_mac, time_series){
		var packet = [244, 8, 0, 0, 0, time_series];
		return this.config_send(sensor_mac, packet);
	}
	config_set_reading_type(sensor_mac, reading_type){
		var packet = [244, 4, 0, 0, 0, reading_type];
		return this.config_send(sensor_mac, packet);
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
				fulfill(toMac(res.data.slice(0, 4)));
			}).catch(reject);
		});
	}
	config_get_pan_id(sensor_mac, node_id, sensor_type){

		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [247, 25, 0, 0, 0]).then((res) => {
				fulfill(res.data.slice(0, 2).reduce(msbLsb));
			}).catch(reject);
		});
	}
	config_get_change_detection(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [247, 26, 0, 0, 0]).then((res) => {
				fulfill({
					enabled: res[0],
					threshold: res[1],
					interval: res.data.slice(2, 5).reduce(msbLsb)
				});
			}).catch(reject);
		});
	}
	config_get_cm_calibration(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 2, 0, 0, 0]).then((res) => {
				fulfill(res.data.slice(0, 2).reduce(msbLsb) / 100);
			}).catch(reject);
		});
	}
	config_get_bp_altitude(sensor_mac){
		this.config_send(sensor_mac, [244, 5, 0, 0, 0]).then((res) => {
			fulfill(res.data.slice(0, 2).reduce(msbLsb));
		}).catch(reject);
	}
	config_get_bp_pressure(sensor_mac){
		this.config_send(sensor_mac, [244, 8, 0, 0, 0]).then((res) => {
			fulfill(res.data.slice(0, 2).reduce(msbLsb));
		}).catch(reject);
	}
	config_get_bp_temp_precision(sensor_mac){
		return this.config_send(sensor_mac, [244, 6, 0, 0, 0]);
	}
	config_get_bp_press_precision(sensor_mac){
		return this.config_send(sensor_mac, [244, 7, 0, 0, 0]);
	}
	config_get_amgt_accel(sensor_mac){
		return this.config_send(sensor_mac, [244, 4, 0, 0, 0]);
	}
	config_get_amgt_magnet(sensor_mac){
		return this.config_send(sensor_mac, [244, 5, 0, 0, 0]);
	}
	config_get_amgt_gyro(sensor_mac){
		return this.config_send(sensor_mac, [244, 6, 0, 0, 0]);
	}
	config_get_impact_accel(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 5, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_impact_data_rate(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 6, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_impact_threshold(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 7, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_impact_duration(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 8, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_activ_interr(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 10, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_filtering(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 5, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_data_rate(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 6, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_time_series(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 9, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
			}).catch(reject);
		});
	}
	config_get_reading_type(sensor_mac){
		return new Promise((fulfill, reject) => {
			this.config_send(sensor_mac, [244, 7, 0, 0, 0]).then((res) => {
				fulfill(res.data[0]);
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
	config_powered_device(sensor_mac, param, ...data){
		var params = {
			destination: 0,
			network_id: 1,
			power: 2,
			retries: 3,
			node_id: 4,
			delay: 5
		};
		return this.config_send(sensor_mac, [(data ? 247 : 248), params[param], ...data]);
	}
	config_send(sensor_mac, data, opts){
		var that = this;
		return new Promise((fulfill, reject) => {
			that.queue.add(() => {
				return new Promise((f, r) => {
					var tout;
					function fail(packet){
						that._emitter.removeListener('config_ack-'+sensor_mac, pass);
						//console.log(data, packet);
						clearTimeout(tout);
						reject({
							err: packet,
							sent: [mac2bytes(sensor_mac), data, opts]
						});
						f();
					}
					function pass(packet){
						clearTimeout(tout);
						that._emitter.removeListener('config_error-'+sensor_mac, fail);
						fulfill(packet);
						f();
					};

					that._emitter.once('config_ack-'+sensor_mac, pass);
					that._emitter.once('config_error-'+sensor_mac, fail);
					tout = setTimeout(() => {
						that._emitter.removeListener('config_error-'+sensor_mac, fail);
						that._emitter.removeListener('config_ack-'+sensor_mac, pass);
						//console.log(data, packet);
						reject({
							err: 'No config err or ack, timeout',
							sent: [mac2bytes(sensor_mac), data, opts]
						});
						f();
					}, 1500);
					that.send.transmit_request(mac2bytes(sensor_mac), data, opts).then().catch((err) => {
						that._emitter.removeListener('config_error-'+sensor_mac, fail);
						that._emitter.removeListener('config_ack-'+sensor_mac, pass);
						//console.log(data, packet);
						reject({
							err: err,
							sent: [mac2bytes(sensor_mac), data, opts]
						});
						f();
					}).then();
				});
			});
			this.queue.add(() => {
				return new Promise((f, r) => {
					setTimeout(f, 500);
				});
			});
		});
	}
	control_send(sensor_mac, data, opts){
		var that = this;
		return new Promise((fulfill, reject) => {
			that.queue.add(() => {
				return new Promise((f, r) => {
					var failed = false;
					var retries = 0;
					var tO;
					function fail(packet){
						failed = true;
						clearTimeout(tO);
						that._emitter.removeListener('sensor_data-'+sensor_mac, pass);
						reject({
							err: packet,
							sent: [sensor_mac, data]
						});
						r();
					}
					function pass(packet){
						if(failed) return;
						console.log('got control response');
						clearTimeout(tO);
						fulfill(packet);
						f();
					};
					that._emitter.once('sensor_data-'+sensor_mac, pass);
					// console.log('sensor_data-'+sensor_mac);

					function send(){
						console.log('sending control command');
						that.send.transmit_request(mac2bytes(sensor_mac), data, opts).then(() => {
							tO = setTimeout(() => {
								if(retries < 1){
									retries++;
									send();
								}else{
									fail('Control response timeout');
								}
							}, 1000);
						}).catch(fail);
					}
					send();
				});
			});
		});
	}
	on(e,cb){this._emitter.on(e,cb);}
};

function sensor_types(parent){
	var types = {
		'1': {
			name: 'Temperature/Humidity',
			parse: (d) => {
				return {
					humidity: msbLsb(d[0], d[1])/100,
					temperature: signInt((msbLsb(d[2], d[3])), 16)/100
				};
			}
		},
		'2': {
			name: '2 Channel Push Notification',
			parse: (d) => {
				return {
					input_1: d[0],
					input_2: d[1]
				};
			}
		},
		'3': {
			name: 'ADC',
			parse: (d) => {
				return {
					input_1: msbLsb(d[0], d[1]),
					input_2: msbLsb(d[2], d[3])
				};
			}
		},
		'4': {
			name: 'Thermocouple',
			parse: (d) => {
				return {
					temperature: signInt(d.slice(0, 4).reduce(msbLsb), 32)/100,
				};
			}
		},
		'5': {
			name: 'Gyro/Magneto/Temperature',
			parse: (d) => {
				return {
					accel_x: signInt(d.slice(0, 3).reduce(msbLsb), 24)/100,
					accel_y: signInt(d.slice(3, 6).reduce(msbLsb), 24)/100,
					accel_z: signInt(d.slice(6, 9).reduce(msbLsb), 24)/100,
					magneto_x: signInt(d.slice(9, 12).reduce(msbLsb), 24)/100,
					magneto_y: signInt(d.slice(12, 15).reduce(msbLsb), 24)/100,
					magneto_z: signInt(d.slice(15, 18).reduce(msbLsb), 24)/100,
					gyro_x: signInt(d.slice(18, 21).reduce(msbLsb), 24),
					gyro_y: signInt(d.slice(21, 24).reduce(msbLsb), 24),
					gyro_z: signInt(d.slice(24, 27).reduce(msbLsb), 24),
					temperature: signInt(msbLsb(d[27], d[28]), 16)
				};
			}
		},
		'6': {
			name: 'Temperature/Barometeric Pressure',
			parse: (d) => {
				return {
					temperature: signInt(msbLsb(d[0], d[1]), 16),
					absolute_pressure: msbLsb(d[2], d[3])/1000,
					relative_pressure: signInt(msbLsb(d[4], d[5]), 16)/1000,
					altitude_change: signInt(msbLsb(d[6], d[7]), 16)/100
				};
			}
		},
		'7': {
			name: 'Impact Detection',
			parse: (d) => {
				return {
					acc_x1: signInt(d.slice(0, 2).reduce(msbLsb), 16),
					acc_x2: signInt(d.slice(2, 4).reduce(msbLsb), 16),
					acc_x: signInt(d.slice(4, 6).reduce(msbLsb), 16),
					acc_y1: signInt(d.slice(6, 8).reduce(msbLsb), 16),
					acc_y2: signInt(d.slice(8, 10).reduce(msbLsb), 16),
					acc_y: signInt(d.slice(10, 12).reduce(msbLsb), 16),
					acc_z1: signInt(d.slice(12, 14).reduce(msbLsb), 16),
					acc_z2: signInt(d.slice(14, 16).reduce(msbLsb), 16),
					acc_z: signInt(d.slice(16, 18).reduce(msbLsb), 16),
					temp_change: signInt(d.slice(18, 20).reduce(msbLsb), 16),
				};
			}
		},
		'8': {
			name: 'Vibration',
			parse: (d) => {
				return {
					rms_x: signInt(d.slice(0, 3).reduce(msbLsb), 24)/100,
					rms_y: signInt(d.slice(3, 6).reduce(msbLsb), 24)/100,
					rms_z: signInt(d.slice(6, 9).reduce(msbLsb), 24)/100,
					max_x: signInt(d.slice(9, 12).reduce(msbLsb), 24)/100,
					max_y: signInt(d.slice(12, 15).reduce(msbLsb), 24)/100,
					max_z: signInt(d.slice(15, 18).reduce(msbLsb), 24)/100,
					min_x: signInt(d.slice(18, 21).reduce(msbLsb), 24)/100,
					min_y: signInt(d.slice(21, 24).reduce(msbLsb), 24)/100,
					min_z: signInt(d.slice(24, 27).reduce(msbLsb), 24)/100,
					temperature: signInt(msbLsb(d[27], d[28]), 16)
				};
			}
		},
		'9': {
			name: 'Proximity',
			parse: (d) => {
				return {
					proximity: msbLsb(d[0], d[1]),
					lux: msbLsb(d[2], d[3]) * .25
				};
			}
		},
		'10': {
			name: 'Light',
			parse: (d) => {
				return {
					lux: d.slice(0, 3).reduce(msbLsb)
				};
			}
		},
		'12': {
			name: '3-Channel Thermocouple',
			parse: (d) => {
				return {
					channel_1: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 100,
					channel_2: signInt(d.slice(4, 8).reduce(msbLsb), 32) / 100,
					channel_3: signInt(d.slice(8, 12).reduce(msbLsb), 32) / 100
				};
			}
		},
		'13': {
			name: 'Current Monitor',
			parse: (d) => {
				return {
					amps: d.slice(0, 3).reduce(msbLsb)/1000
				};
			}
		},
		'14': {
			name: '10-Bit 1-Channel 4-20mA',
			parse: (d) => {
				var adc = d.slice(0, 2).reduce(msbLsb);
				return {
					adc: adc,
					mA: adc * 20 / 998
				};
			}
		},
		'15': {
			name: '10-Bit 1-Channel ADC',
			parse: (d) => {
				var adc = d.slice(0, 2).reduce(msbLsb);
				return {
					adc: adc,
					voltage: adc * 0.00322265625
				};
			}
		},
		'16': {
			name: 'Soil Moisture Sensor',
			parse: (d) => {
				var adc1 = d.slice(0, 2).reduce(msbLsb);
				var adc2 = d.slice(2, 4).reduce(msbLsb);
				return {
					adc1: adc1,
					adc2: adc2,
					voltage1: adc1 * 0.00322265625,
					voltage2: adc2 * 0.00322265625,
					percentage: adc1 > 870 ? 100 : Math.round(adc1 / 870 * 100)
				};
			}
		},
		'17': {
			name: '24-Bit AC Voltage Monitor',
			parse: (d) => {
				return {
					voltage: d.slice(0, 3).reduce(msbLsb) / 1000
				};
			}
		},
		'18': {
			name: 'Pulse/Frequency Meter',
			parse: (d) => {
				return {
					frequency: d.slice(0, 3).reduce(msbLsb) / 1000,
					duty_cycle: d.slice(3, 5).reduce(msbLsb) / 100
				};
			}
		},
		'19': {
			name: '2-channel 24-bit Current Monitor',
			parse: (d) => {
				return {
					channel_1: d.slice(0, 3).reduce(msbLsb),
					channel_2: d.slice(4, 7).reduce(msbLsb),
				};
			}
		},
		'20': {
			name: 'Precision Pressure & Temperature (pA)',
			parse: (d) => {
				return {
					pressure: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 1000,
					temperature: signInt(d.slice(4, 6).reduce(msbLsb), 16) / 100
				};
			}
		},
		'21': {
			name: 'AMS Pressure & Temperature',
			parse: (d) => {
				return {
					pressure: signInt(d.slice(0, 2).reduce(msbLsb), 16) / 100,
					temperature: signInt(d.slice(2, 4).reduce(msbLsb), 16) / 100,
				};
			}
		},
		'22': {
			name: 'Voltage Detection Input',
			parse: (d) => {
				return {
					input: d[0]
				};
			}
		},
		'23': {
			name: '2-Channel Thermocouple',
			parse: (d) => {
				return {
					channel_1: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 100,
					channel_2: signInt(d.slice(4, 8).reduce(msbLsb), 32) / 100,
				};
			}
		},
		'24': {
			name: 'Activity Detection',
			parse: (d) => {
				return {
					acc_x: signInt(d.slice(0, 2).reduce(msbLsb), 16),
					acc_y: signInt(d.slice(2, 4).reduce(msbLsb), 16),
					acc_z: signInt(d.slice(4, 6).reduce(msbLsb), 16),
					temp_change: signInt(d.slice(6, 8).reduce(msbLsb), 16),
				};
			}
		},
		'25': {
			name: 'Asset Monitor',
			parse: (d) => {
				return {
					acc_x: signInt(d.slice(0, 2).reduce(msbLsb), 16),
					acc_y: signInt(d.slice(2, 4).reduce(msbLsb), 16),
					acc_z: signInt(d.slice(4, 6).reduce(msbLsb), 16),
					temp_change: signInt(d.slice(6, 8).reduce(msbLsb), 16),
				};
			}
		},
		'26': {
			name: 'Pressure & Temperature Sensor (PSI)',
			parse: (d) => {
				return {
					pressure: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 100,
					temperature: signInt(d.slice(4, 6).reduce(msbLsb), 16) / 100
				};
			}
		},
		'27': {
			name: 'Environmental',
			parse: (d) => {
				return {
					temperature: signInt(d.slice(0, 2).reduce(msbLsb), 16) / 100,
					pressure: d.slice(2, 6).reduce(msbLsb) / 100,
					humidity: d.slice(6, 10).reduce(msbLsb) / 1000,
					gas_resistance: d.slice(10, 14).reduce(msbLsb),
					iaq: d.slice(14, 16).reduce(msbLsb)

				};
			}
		},
		'28': {
			'name': '24-Bit 3-Channel Current Monitor',
			parse: (d) => {
				return {
					channel_1: d.slice(0, 3).reduce(msbLsb),
					channel_2: d.slice(4, 7).reduce(msbLsb),
					channel_3: d.slice(8, 11).reduce(msbLsb)
				};
			}
		},
		'29': {
			'name': 'Linear Displacement Sensor',
			parse: (d) => {
				var adc = d.slice(0, 2).reduce(msbLsb);
				return {
					adc: adc,
					position: adc/1023*100,
				};
			}
		},
		'30': {
			'name': 'Structural Monitoring Sensor',
			parse: (d) => {
				var adc = d.slice(0, 2).reduce(msbLsb);
				return {
					adc: adc,
					position: adc/1023*100,
				};
			}
		},
		'32': {
			'name': 'Particulate Matter Sensor',
			parse: (d) => {
				return {
					mass_concentration_1_0:    d.slice(0, 4).reduce(msbLsb)/100,
					mass_concentration_2_5:    d.slice(4, 8).reduce(msbLsb)/100,
					mass_concentration_4_0:    d.slice(8, 12).reduce(msbLsb)/100,
					mass_concentration_10_0:   d.slice(12, 16).reduce(msbLsb)/100,
					number_concentration_0_5:  d.slice(16, 20).reduce(msbLsb)/100,
					number_concentration_1_0:  d.slice(20, 24).reduce(msbLsb)/100,
					number_concentration_2_5:  d.slice(24, 28).reduce(msbLsb)/100,
					number_concentration_4_0:  d.slice(28, 32).reduce(msbLsb)/100,
					number_concentration_10_0: d.slice(32, 36).reduce(msbLsb)/100,
					typical_size:              d.slice(36, 40).reduce(msbLsb)/100
				};
			}
		},
		'34': {
			name: 'Tank Level Sensor',
			parse: (d) => {
				return {
					level: msbLsb(d[0], d[1])
				};
			}
		},
		'35': {
			name: 'One Channel Counter',
			parse: (d) => {
				return {
					counts: d.slice(0, 4).reduce(msbLsb)
				};
			}
		},
		'36': {
			name: 'Two Channel Counter',
			parse: (d) => {
				return {
					counts_1: msbLsb(d[0], d[1]),
					counts_2: msbLsb(d[2], d[3])
				};
			}
		},
		'37': {
			name: '7 Channel Push Notification',
			parse: (d) => {
				return {
					input_1: d[0] & 1 ? 1 : 0,
					input_2: d[0] & 2 ? 1 : 0,
					input_3: d[0] & 4 ? 1 : 0,
					input_4: d[0] & 8 ? 1 : 0,
					input_5: d[0] & 16 ? 1 : 0,
					input_6: d[0] & 32 ? 1 : 0,
					input_7: d[0] & 64 ? 1 : 0,
					adc_1: msbLsb(d[1], d[2]),
					adc_2: msbLsb(d[3], d[4]),
				};
			}
		},
		'39': {
			name: 'RTD Temperature Sensor',
			parse: (d) => {
				return {
					temperature: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 100,
				};
			}
		},
		'40': {
			name: 'Vibration w/Time Domain (partial support)',
			parse: (d, full) => {
				var status = {
					0: 'Valid',
					63: 'Invalid Argument',
					62: 'Internal Sensor Communication Failure',
					61: 'Invalid Sensor Discovery',
					60: 'Invalid Length',
					59: 'ASIC Test Failure',
					58: 'Device Initialization Failure',
					57: 'Soft Reset Failure'
				};
				return {
					status: status[full[7] >> 2],
					reserve: full[7],
					data_type: ['unknown', 'Acceleration', 'Velocity', 'Time Domain'][full[7] & 3],
					rms_x: signInt(d.slice(0, 3).reduce(msbLsb), 24)/100,
					rms_y: signInt(d.slice(3, 6).reduce(msbLsb), 24)/100,
					rms_z: signInt(d.slice(6, 9).reduce(msbLsb), 24)/100,
					max_x: signInt(d.slice(9, 12).reduce(msbLsb), 24)/100,
					max_y: signInt(d.slice(12, 15).reduce(msbLsb), 24)/100,
					max_z: signInt(d.slice(15, 18).reduce(msbLsb), 24)/100,
					min_x: signInt(d.slice(18, 21).reduce(msbLsb), 24)/100,
					min_y: signInt(d.slice(21, 24).reduce(msbLsb), 24)/100,
					min_z: signInt(d.slice(24, 27).reduce(msbLsb), 24)/100,
					temperature: signInt(msbLsb(d[27], d[28]), 16)
				};
			}
		},
		'41': {
			name: 'RPM',
			parse: (d) => {
				return {
					proximity: msbLsb(d[0], d[1]),
					rpm: msbLsb(d[2], d[3]) * .25
				};
			}
		},
		'44': {
			name: 'Wireless CO2 Gas Sensor',
			parse: (d) => {
				return {
					CO2:    d.slice(0, 4).reduce(msbLsb)/100,
					humidity: msbLsb(d[4], d[5])/100,
					temperature: signInt((msbLsb(d[6], d[7])), 16)/100
				};
			}
		},
		'45': {
			name: '16-Bit 1-Channel 4-20mA',
			parse: (d) => {
				var adc = signInt(d.slice(0, 2).reduce(msbLsb));
				return {
					adc: adc,
					mA: adc * 20 / 28842,
					byteOne: d[0],
					byteTwo: d[1]
				};
			}
		},
		'50': {
			name: 'Predictive Maintenance Sensor',
			parse: (d) => {
				return {
					rms_x: signInt(d.slice(0, 3).reduce(msbLsb), 24)/100,
					rms_y: signInt(d.slice(3, 6).reduce(msbLsb), 24)/100,
					rms_z: signInt(d.slice(6, 9).reduce(msbLsb), 24)/100,
					max_x: signInt(d.slice(9, 12).reduce(msbLsb), 24)/100,
					max_y: signInt(d.slice(12, 15).reduce(msbLsb), 24)/100,
					max_z: signInt(d.slice(15, 18).reduce(msbLsb), 24)/100,
					min_x: signInt(d.slice(18, 21).reduce(msbLsb), 24)/100,
					min_y: signInt(d.slice(21, 24).reduce(msbLsb), 24)/100,
					min_z: signInt(d.slice(24, 27).reduce(msbLsb), 24)/100,
					vibration_temperature: signInt(msbLsb(d[27], d[28]), 16),
					thermocouple_temperature: signInt(d.slice(29, 33).reduce(msbLsb), 32) / 100,
					current: signInt(d.slice(33, 36).reduce(msbLsb), 24) / 1000
				};
			}
		},
		'52': {
            name: '16-Bit 2-Channel 4-20mA',
            parse: (d) => {
                var adc1 = signInt(d.slice(0, 2).reduce(msbLsb));
                var adc2 = signInt(d.slice(2, 4).reduce(msbLsb));
                return {
                    adc1: adc1,
                    adc2: adc2,
                    mA1: adc1 * 0.0006863,
                    mA2: adc2 * 0.0006863,
                    byteOne: d[0],
                    byteTwo: d[1],
                    byteTwo: d[2],
                    byteTwo: d[3]
                };
            }
        },
		'64': {
			name: 'EC Salinity TDS and Temperature Sensor',
			parse: (d) => {
				return {
					EC: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 100,
					TDS: signInt(d.slice(4, 8).reduce(msbLsb), 32) / 100,
					Salinity: signInt(d.slice(8, 12).reduce(msbLsb), 32) / 100,
					Temp: signInt(d.slice(12, 14).reduce(msbLsb),16) / 100,
				};
			}
		},

		'65': {
			name: 'Dissolved Oxygen and Temperature Sensor',
			parse: (d) => {
				return {
					DO: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 100,
					DO_Saturation: signInt(d.slice(4, 8).reduce(msbLsb), 32) / 100,
					Temp: signInt(d.slice(8, 10).reduce(msbLsb),16) / 100,
				};
			}
		},

		'66': {
			name: 'EC and Dissolved Oxygen and Temperature Sensor',
			parse: (d) => {
				return {
					EC: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 100,
					TDS: signInt(d.slice(4, 8).reduce(msbLsb), 32) / 100,
					Salinity: signInt(d.slice(8, 12).reduce(msbLsb), 32) / 100,
					Temp: signInt(d.slice(12, 14).reduce(msbLsb),16) / 100,

					DO: signInt(d.slice(14, 18).reduce(msbLsb), 32) / 100,
					DO_Saturation: signInt(d.slice(18, 22).reduce(msbLsb), 32) / 100,
					Temp: signInt(d.slice(22, 24).reduce(msbLsb),16) / 100,
				};
			}
		},

		'67': {
			name: 'PAR Sensor',
			parse: (d) => {
				return {
					PAR: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 100,
				};
			}
		},

		'200': {
            name: '4-20mA Pass Through',
            parse: (d) => {
                var adc1 = signInt(d.slice(0, 2).reduce(msbLsb));
                var adc2 = signInt(d.slice(2, 4).reduce(msbLsb));
                var dac1 = signInt(d.slice(4, 6).reduce(msbLsb));
                return {
                    adc1: adc1,
                    adc2: adc2,
                    dac1: dac1,
                    mA1: adc1/100.00,
                    raw_adc: adc2,
                    raw_dac: dac1,
                    byteOne: d[0],
                    byteTwo: d[1],
                    byteThree: d[2],
                    byteFour: d[3],
                    byteFive: d[4],
                    byteSix: d[5],
                };
            }
        },

		'202': {
			name: 'Wireless Weather Station',
			parse: (d) => {
				return {
					Temp: signInt(d.slice(0, 4).reduce(msbLsb), 32) / 100,
					Humid: signInt(d.slice(4, 8).reduce(msbLsb), 32) / 100,
					Pressure: signInt(d.slice(8, 12).reduce(msbLsb), 32) / 100,
					WindSpd: signInt(d.slice(12, 16).reduce(msbLsb),32) / 100,
					WindDir: signInt(d.slice(16, 20).reduce(msbLsb),32) / 100,

				};
			}
		},
		'510': {
			name: 'GreenLight',
			parse: (d) => {
				var adc = d.slice(0, 2).reduce(msbLsb);
				return {
					mA: adc /100.00
				};
			}
		},
		'10000':{
			name: '4-Relay',
			parse: (d) => {
				return {
					relay_1: d[0] & 1 ? 1 : 0,
					relay_2: d[0] & 2 ? 1 : 0,
					relay_3: d[0] & 4 ? 1 : 0,
					relay_4: d[0] & 8 ? 1 : 0
				};
			},
			control: (msg) => {
				switch(msg.topic){
					case 'all':
						return [3, parseInt(msg.payload)];
					case 'get_status':
						return [2];
					default:
						return [parseInt(msg.payload), parseInt(msg.topic.split('_').pop())];
				}
			}
		},
		'10006':{
			name: '4-Channel 4-20 mA Input',
			parse: (d) => {
				var readings = {};
				for(var i=0;i++;i<4) readings[`channel_${i+1}`] = d.slice((i*2), 1+(i*2)).reduce(msbLsb) / 100;
				return readings;
			}
		},
		'10007':{
			name: '4-Channel Current Monitor',
			parse: (d) => {
				var readings = {};
				for(var i=0;i++;i<4) readings[`channel_${i+1}`] = d.slice((i*3), 2+(i*3)).reduce(msbLsb) / 1000;
				return readings;
			}
		},
		'10012':{
			name: '2-Relay + 2-Input',
			parse: (d) => {
				return {
					relay_1: d[0] & 1 ? 1 : 0,
					relay_2: d[0] & 2 ? 1 : 0,
					input_1: d[1] & 1 ? 1 : 0,
					input_2: d[1] & 2 ? 1 : 0
				};
			},
			control: (msg) => {

				switch(msg.topic){
					case 'all':
						return [3, parseInt(msg.payload)];
					case 'get_status':
						return [2];
					default:
						return [parseInt(msg.payload), parseInt(msg.topic.split('_').pop())];
				}
			}
		},
	};
	return types;
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
function mac2bytes(mac){
	return mac.split(':').map((v) => parseInt(v, 16));
}
function msbLsb(m,l){return (m<<8)+l;}
function toHex(n){return ('00' + n.toString(16)).substr(-2);}

function toMac(arr){
	return arr.reduce((h,c,i) => {return (i==1?toHex(h):h)+':'+toHex(c);});
}
function byte2mac(h,c,i){return h.constructor == Array ? h.reduce(byte2mac) : (i==1?h.toHex():h)+':'+c.toHex();}
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
function signInt(i, b){
	if(i.toString(2).length != b) return i;
	return -(((~i) & ((1 << (b-1))-1))+1);
}

//signInt=(d,b) => d>1<<(b-2)?0-((1<<b)-d):d;
