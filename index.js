var serialPool = {};
const events = require("events");
const sp = require('serialport');

class SerialConnection{
	constructor(port, baudRate){
		this.port = port;
		this.baudRate = baudRate;
		this._emitter = new events.EventEmitter();
		this.tout = null;
		this.serialReconnectTime = 3000;
		this.setupSerial();
	}
	reconnect(){
		var obj = this;
		if (!obj._closing) {
			obj._closing = true;
			obj._available = false;
			obj._emitter.emit('closed');
			obj.tout = setTimeout(function() {
				obj.setupSerial();
			}, obj.serialReconnectTime);
		}
	}
	setupSerial(){
		var obj = this;
		obj._closing = false;
		this.serial = new sp(this.port, {
			baudRate: this.baudRate,
			autoOpen: true
		});

		this.serial.on('error', function(err) {
			obj.reconnect();
		});
		this.serial.on('close', function() {
			obj.reconnect();
		});
		this.serial.on('open',function() {
			obj._closing = false;
			obj._available = true;
			if (obj.tout) { clearTimeout(obj.tout); }
			obj._emitter.emit('ready');
		});
		this.serial.on('data',function(d) {
			for (var z=0; z<d.length; z++) {
				obj._emitter.emit('data',d[z]);
			}
		});
	}
	on(a,b){ this._emitter.on(a,b); }
	close(cb){ this.serial.close(cb); }
	write(m,cb){ this.serial.write(m, cb); }
}

class NcdWireless{
	constructor(comm){
		this.comm = comm;
		this._emitter = new events.EventEmitter();
		this.temp = [];
		var that = this;
		function dataInClosure(d){
			that.dataIn(d);
		}
		this.comm.on('data', dataInClosure);
		this._emitter.on('close', () => {
			that.comm._emitter.removeListener('data', dataInClosure);
		})
	}

	dataIn(d){
		if(this.temp.length > 0 || d == 126){
			this.temp.push(d);
			if(this.temp.length > 4){
				var validate = this.validateDigi(this.temp);
				var length = msbLsb(this.temp[1], this.temp[2]);
				if(validate == 0){
					var msg = {
						packet_length: length,
						frame_type: this.temp[3],
						original: this.temp,
						payload: this.temp.slice(4, -1)
					};
					this.temp = [];
					this._emitter.emit('digi-in', msg);
					if(msg.frame_type == 144 && pckt[15] == 0x7F){
						var packet = this.processPacket(msg.original);
						this._emitter.emit('sensor-packet', packet);
					}
				}else if(this.temp.length-4 > length){
					this.temp = [];
				}
			}
		}
	}

	validateDigi(pckt){
		if(pckt[0] != 126) return 1;
		if((pckt.length-4) != msbLsb(pckt[1], pckt[2])) return 2;
		if((255 - (pckt.slice(3,-1).reduce((t, n) => {return t+n;}) & 255)) == pckt[pckt.length-1]) return 0;
		return 3;
	}

	processPacket(pckt){
		var addr = pckt.slice(4, 12);
		var payload = pckt.slice(15, -1);
		var data = {
			addrB: addr,
			addr: addr.reduce((h,i) => {return h+=':'+i.toHex();}),
			location: payload[1],
			timeStamp: new Date().getTime() / 1000,//getDateTime(),
			firmware: payload[2],
			battery: msbLsb(payload[3], payload[4]) * 0.0032,
			sensorType: msbLsb(payload[6], payload[7]),
			transmission_id: payload[5]
		};
		return this.addSensorData(data, payload);
	}

	addSensorData(data, d){
		var readings = {};
		switch(data.sensorType){
			case 1:
				readings.humidity = msbLsb(d[9], d[10])/100;
			case 4:
				readings.temperature = (msbLsb(d[11], d[12])/100)*1.8+32;
				break;
			case 2:
				readings.input_1 = d[9];
				readings.input_2 = d[10];
				break;
			case 3:
				readings.input_1 = msbLsb(d[9], d[10]);
				readings.input_2 = msbLsb(d[11], d[12]);
				break;
			case 10:
				readings.lux = d.slice(9, 12).reduce(msbLsb);
				break;
			case 10006:
				for(var i=0;i++;i<4) readings[`channel_${i+1}`] = d.slice(9+(i*2), 10+(i*2)).reduce(msbLsb) / 100;
				break;
			case 10007:
				for(var i=0;i++;i<4) readings[`channel_${i+1}`] = d.slice(9+(i*3), 11+(i*3)).reduce(msbLsb) / 1000;
				break;
			case 10012:
				//relay controller
				readings.relay_1 = d[9];
				readings.relay_2 = d[10];
				readings.input_1 = d[11] ? "On" : "Off";
				readings.input_2 = d[12] ? "On" : "Off";
				break;

		}
		data.readings = readings;
		return data;
	}
	on(a,b){ this._emitter.on(a,b); }
	close(){ this._emitter.emit('close'); }
}

function NcdSerial(port, baudRate){
	baudRate *= 1;
	if(typeof serialPool[port] == 'undefined'){
		serialPool[port] = new SerialConnection(port, baudRate);
	}else if(baudRate != serialPool[port].baudRate){
		serialPool[port].baudRate = baudRate;
		serialPool[port].close();
	}
	return serialPool[port];
}


Number.prototype.toHex = function(){return ("00" + this.toString(16)).substr(-2);}

function msbLsb(m,l){return (m<<8)+l;}

module.exports = {
	Wireless: NcdWireless,
	Serial: NcdSerial,
	SerialList: function(res){
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
}
