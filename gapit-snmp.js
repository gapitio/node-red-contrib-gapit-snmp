
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

    function getGapitCodeResultsStructure(gapit_code) {
        // Create a copy of gapit_code for storing results.
        //
        // Remove keys which should be runtime data, which 
        // may be present in older JSON files.

        const group_remove_keys = ["next_read"]
        const member_remove_keys = ["value"]

        // deep copy using JSON stringify/parse
        var gapit_results = JSON.parse(JSON.stringify(gapit_code));

        for (const [groups_key, groups] of Object.entries(gapit_results)) {
            for (var group_idx = 0; group_idx < groups.length; group_idx++) { 
                // remove specified group keys
                for (const group_key of group_remove_keys) {
                    if (group_key in groups[group_idx]) {
                        delete groups[group_idx][group_key];
                    }
                }
                for (var member_idx = 0; member_idx < groups[group_idx]["group"].length; member_idx++) { 
                    // remove specified member keys
                    for (const member_key of member_remove_keys) {
                        if (member_key in groups[group_idx]["group"][member_idx]) {
                            delete groups[group_idx]["group"][member_idx][member_key];
                        }
                    }
                }
            }
        };

        return gapit_results;
    }


    function GapitSnmpNode(config) {
        RED.nodes.createNode(this, config);
        this.community = config.community;
        this.host = config.host;
        this.version = (config.version === "2c") ? snmp.Version2c : snmp.Version1;
        if (config.gapit_code) {
            this.gapit_code = JSON.parse(config.gapit_code);
        }
        this.skip_nonexistent_oids = config.skip_nonexistent_oids;
        this.remove_novalue_items_from_gapit_results = config.remove_novalue_items_from_gapit_results;
        this.timeout = Number(config.timeout || 5) * 1000;
        // add db tags from config to node
        this.db_tags = {}
        for (const [key, val] of Object.entries(config)) {
            if (key.startsWith("tagname_")) {
                var tag_name = key.substr("tagname_".length);
                var tagvalue_key = "tagvalue_" + tag_name
                // console.info("Found tag " + tag_name + ", looking for " + tagvalue_key)
                if (tagvalue_key in config) {
                    console.debug("Adding tag " + config[key] + ": " + config[tagvalue_key])
                    this.db_tags[config[key]] = config[tagvalue_key];
                }
                else {
                    console.warn("Could not find matching " + tagvalue_key + " for " + key);
                }
            }
        }
        /*console.log("### db_tags:");
        for (const [key, val] of Object.entries(this.db_tags)) {
            console.debug("   " + key + ": " + val);
        }*/
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
            var remove_novalue_items_from_gapit_results = node.remove_novalue_items_from_gapit_results;

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

            // get result structure
            var gapit_results = getGapitCodeResultsStructure(gapit_code);

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
                                if (varbinds[i].type == snmp.ObjectType.NoSuchInstance || 
                                    varbinds[i].type == snmp.ObjectType.NoSuchObject) {
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

                        // map result values into gapit_results
                        // also, optionally remove items with no value
                        var oids = Array()
                        for (const [groups_key, groups] of Object.entries(gapit_results)) {
                            for (var group_idx = 0; group_idx < groups.length; group_idx++) { 
                                // iterate array in reverse, to enable deletion
                                for (var member_idx = groups[group_idx]["group"].length - 1; member_idx >= 0 ; member_idx--) { 
                                    var oid = groups[group_idx]["group"][member_idx]["address"];
                                    if (oid in oid_value_map) {
                                        groups[group_idx]["group"][member_idx]["value"] = oid_value_map[oid];
                                    }
                                    else if (remove_novalue_items_from_gapit_results) {
                                        groups[group_idx]["group"].splice(member_idx, 1);
                                        //node.warn("should delete this");
                                    }
                                }
                            }
                        };

                        msg.db_tags = node.db_tags;
                        msg.oid = oids;
                        msg.varbinds = varbinds;
                        msg.oid_value_map = oid_value_map;
                        msg.gapit_code = gapit_code;
                        msg.gapit_results = gapit_results;
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


    function GapitResultsToInfluxBatchNode(config) {
        RED.nodes.createNode(this,config);
        var node = this;
        node.on('input', function(msg) {
            var payload_tmp = Array()

            for (const [groups_key, groups] of Object.entries(msg.gapit_results)) {
                for (var group_idx = 0; group_idx < groups.length; group_idx++) { 
                    // check for "value" in case gapit_results wasn't filtered before
                    // only create measurement data if there are measurements for the group
                    var values_found = false
                    for (var member_idx = 0; member_idx < groups[group_idx]["group"].length; member_idx++) { 
                        if ("value" in groups[group_idx]["group"][member_idx]) {
                            values_found = true;
                            break;
                        }
                    }
                    if (values_found) {
                        // prepare object for measurement
                        var measurement_tmp = {}
                        measurement_tmp.measurement = groups[group_idx]["group_name"];
                        measurement_tmp.fields = {}
                        measurement_tmp.tags = msg.db_tags
                        measurement_tmp.timestamp = msg.ts; //probably need to be a Date
                        // add fields
                        for (var member_idx = 0; member_idx < groups[group_idx]["group"].length; member_idx++) { 
                            if ("value" in groups[group_idx]["group"][member_idx]) {
                                const description = groups[group_idx]["group"][member_idx]["description"];
                                measurement_tmp.fields[description] = groups[group_idx]["group"][member_idx]["value"];
                            }
                        }
                        // add dynamic tags
                        // ...nothing yet
                        // push to payload_tmp
                        payload_tmp.push(measurement_tmp);
                    }
                }
            };

            msg.payload = payload_tmp;
            node.send(msg);
        });
    }
    RED.nodes.registerType("gapit-results-to-influx-batch", GapitResultsToInfluxBatchNode);
};
