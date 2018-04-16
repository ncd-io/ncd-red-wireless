const ncd = require("./index.js");
module.exports = function(RED) {
	function NcdWirelessNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;
		node.modem = new ncd.Wireless(ncd.Serial(config.port, config.baudRate));
		node.modem.on('sensor-packet', (packet) => {
			packet.payload = packet.readings;
			node.send(packet);
		});
		node.on('close', (removed, done) => {
			node.modem.close();
			delete(node.modem);
			done();
		});
	}
	RED.nodes.registerType("Ncd-Wireless", NcdWirelessNode);
	RED.httpAdmin.get("/ncd/wireless/modems/list", RED.auth.needsPermission('serial.read'), function(req,res) {
		ncd.SerialList(res);
	});

}
