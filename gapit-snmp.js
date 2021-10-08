
module.exports = function (RED) {
    "use strict";
    var snmp = require("net-snmp");

    var sessions = {};

    function getSession(host, community, version, timeout) {
        var sessionKey = host + ":" + community + ":" + version;
        var port = 161;
        if (host.indexOf(":") !== -1) {
            port = host.split(":")[1];
            host = host.split(":")[0];
        }
        if (!(sessionKey in sessions)) {
            sessions[sessionKey] = snmp.createSession(host, community, { port:port, version:version, timeout:(timeout || 5000) });
        }
        return sessions[sessionKey];
    }


    function GapitSnmpNode(config) {
        RED.nodes.createNode(this, config);
        this.community = config.community;
        this.host = config.host;
        this.version = (config.version === "2c") ? snmp.Version2c : snmp.Version1;
        this.gapit_code = JSON.parse(config.gapit_code);
        this.skip_nonexistent_oids = config.skip_nonexistent_oids;
        this.timeout = Number(config.timeout || 5) * 1000;
        var node = this;

        // get context
        var nodeContext = node.context();
        // initialize nonexistent_oids in context
        console.info("initializing nonexistent_oids in context (set to empty Array)")
        nodeContext.set("nonexistent_oids", Array());

        this.on("input", function (msg) {
            var host = node.host || msg.host;
            var community = node.community || msg.community;
            var gapit_code = node.gapit_code || msg.gapit_code;
            var skip_nonexistent_oids = node.skip_nonexistent_oids;

            // get nonexistent_oids from context
            var nonexistent_oids = nodeContext.get("nonexistent_oids");
            // flag to keep track of changes to nonexistent_oids
            var nonexistent_oids_modified = false;

            // build list of OIDs
            var oids = Array()
            for (const [groups_key, groups] of Object.entries(gapit_code)) {
                for (var group_idx = 0; group_idx < groups.length; group_idx++) { 
                    console.info("Getting OIDs from group '" + groups[group_idx]["group_name"] + "'");
                    for (var member_idx = 0; member_idx < groups[group_idx]["group"].length; member_idx++) { 
                        var oid = groups[group_idx]["group"][member_idx]["address"];
                        console.info("Found OID " + oid + " for '" + groups[group_idx]["group"][member_idx]["description"] + "'");
                        if (skip_nonexistent_oids) {
                            if (nonexistent_oids.includes(oid)) {
                                continue;
                            }
                        }
                        oids.push(oid);
                    }
                }
            };

            if (oids.length > 0) {
                getSession(host, community, node.version, node.timeout).get(oids, function (error, varbinds) {
                    if (error) {
                        node.error("SNMPv1 error: " + error.toString(), msg);
                        // handle NoSuchName
                        // "SNMPv1 error: RequestFailedError: NoSuchName: 1.2.3"
                    }
                    else {
                        var varbinds_to_delete = Array();
                        for (var i = 0; i < varbinds.length; i++) {
                            if (snmp.isVarbindError(varbinds[i])) {
                                if (varbinds[i].type == snmp.ObjectType.NoSuchInstance) {
                                    // example code uses snmp.ErrorStatus.NoSuchInstance, 
                                    // but it is actually snmp.ObjectType.NoSuchInstance
                                    // node.warn("SNMPv2+ error: " + snmp.varbindError(varbinds[i]), msg);
                                    node.warn("OID '" + varbinds[i]["oid"] + "' is not present")
                                    // remove varbinds with these errors, instead of throwing an error
                                    // build list of indexes to delete after iteration is complete
                                    varbinds_to_delete.push(i);
                                    // add to context "nonexistent_oids" array if not already there, 
                                    // so the OID can be skipped in the next query
                                    if (skip_nonexistent_oids) {
                                        if (! nonexistent_oids.includes(oid)) {
                                            nonexistent_oids.push(varbinds[i]["oid"]);
                                            nonexistent_oids_modified = true;
                                        }
                                    }
                                }
                                else {
                                    node.error("SNMPv2+ error: " + snmp.varbindError(varbinds[i]), msg);
                                }
                            }
                            else {
                                if (varbinds[i].type == 4) { varbinds[i].value = varbinds[i].value.toString(); }
                                varbinds[i].tstr = snmp.ObjectType[varbinds[i].type];
                                //node.log(varbinds[i].oid + "|" + varbinds[i].tstr + "|" + varbinds[i].value);
                            }
                        }

                        // if modified, save nonexistent_oids to context
                        if (skip_nonexistent_oids) {
                            if (nonexistent_oids_modified) {
                                nodeContext.set("nonexistent_oids", nonexistent_oids)
                            }
                        }

                        // reverse the list of varbinds to delete, 
                        // to delete starting at the end of the array
                        varbinds_to_delete.reverse().forEach(function(i) {
                            varbinds.splice(i, 1);
                        });

                        var oid_value_map = Object();
                        for (var i = 0; i < varbinds.length; i++) {
                            oid_value_map[varbinds[i]["oid"]] = varbinds[i]["value"];
                        }

                        msg.oid = oids;
                        msg.varbinds = varbinds;
                        msg.oid_value_map = oid_value_map;
                        node.send(msg);
                    }
                });
            }
            else {
                node.warn("No oid(s) to search for");
            }
        });
    }
    RED.nodes.registerType("gapit-snmp", GapitSnmpNode);
};
