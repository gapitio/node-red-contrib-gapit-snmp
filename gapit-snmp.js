
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


    class Scaling {
        constructor(name) {
            // set use_scaling to requested scaling
            var scaling_func = "_scaling_" + name;
            if (this[scaling_func] === undefined) {
                console.warn("Could not find scaling function '" + scaling_func + "', falling back to 'general'");
                scaling_func = "_scaling_general";
            }
            else {
                console.debug("Found scaling function '" + scaling_func + "'");
            }
            this.use_scaling = this[scaling_func];
            var scaling_init_func = "_init_scaling_"  + name;
            if (this[scaling_init_func] !== undefined) {
                console.debug("Calling init for scaling '" + name + "'")
                this[scaling_init_func]();
            }
        }

        _init_scaling_schleifenbauer() {
            this.registers = Object();
            // each register field_name set needs its own set of registers
            // these are lazy initialized when the first register of a 
            // field_name is used
        }
        
        _scaling_general(value, scaling_factor, unit, field_name) {
            if (typeof value === "number" && typeof scaling_factor === "number" && scaling_factor != 1) {
                // cast to string with 8 decimals, and convert back to number
                // this is to avoid numbers like 49.900000000000006 (from 499 * 0.1)
                var result = Number((value * scaling_factor).toFixed(8));
                console.debug(`Applied scaling to value ${value} with factor ${scaling_factor}, for result ${result}`);
                return result
            }
            else if (scaling_factor == 1) {
                console.warn("scaling_factor == 1, returning unchanged value");
                return value;
            }
            else {
                console.warn("Value or scaling_factor is not a number, returning unchanged value")
                return value;
            }
        }

        _scaling_schleifenbauer(value, scaling_factor, unit, field_name) {
            console.debug(`Decoding Schleifenbauer with value ${value} and scaling factor ${scaling_factor}`);

            if (typeof value === "number" && typeof scaling_factor === "number" && scaling_factor != 1) {
                // cast to string with 8 fixed decimals, and convert back to number
                // this to avoid numbers like 49.900000000000006
                var result = Number((value * scaling_factor).toFixed(8));
                console.debug(`Applied scaling to value ${value} with factor ${scaling_factor}, for result ${result}`);
            }
            else if (scaling_factor == 1) {
                console.warn("scaling_factor == 1, returning unchanged value");
                return value;
            }
            else {
                console.warn("Value or scaling_factor is not a number, returning unchanged value")
                return value;
            }

            if (unit.startsWith("register")) {
                // this is a register1/2/3 field
                // only the last word of the field names should be different
                // (e.g. "Active Total 1", "Active Total 2")

                // find common field name ("Active Total" in above example)
                var common_field_name = field_name.split(" ").slice(0, -1).join(" ")
                //console.log("common_field_name: " + common_field_name);
                // set up registers for common field name if missing
                if (! (common_field_name in this.registers)) {
                    console.log(`initializing registers for ${common_field_name}`);
                    this.registers[common_field_name] = {
                        "register1": -1, 
                        "register2": -1, 
                        "register3": -1
                    }
                }

                if (unit == "register1") {
                    this.registers[common_field_name]["register1"] = result;
                }
                else if (unit == "register2") {
                    this.registers[common_field_name]["register2"] = result;
                }
                else if (unit == "register3") {
                    this.registers[common_field_name]["register3"] = result;
                }
                else if (unit == "register4") {
                    // if registers 1 through 3 are set (not -1), return sum
                    if (this.registers[common_field_name]["register1"] != -1 &&
                            this.registers[common_field_name]["register2"] != -1 && 
                            this.registers[common_field_name]["register3"] != -1) {
                        console.debug(`All registers set for '${common_field_name}', calculating total`);
                        result = this.registers[common_field_name]["register1"] + 
                            this.registers[common_field_name]["register2"] + 
                            this.registers[common_field_name]["register3"]
                        // reset registers
                        this.registers[common_field_name]["register1"] = -1;
                        this.registers[common_field_name]["register2"] = -1;
                        this.registers[common_field_name]["register3"] = -1;
                    }
                    else {
                        console.debug(`One or more registers was not set for '${common_field_name}', cannot calculate total`);
                        // reset registers
                        this.registers[common_field_name]["register1"] = -1;
                        this.registers[common_field_name]["register2"] = -1;
                        this.registers[common_field_name]["register3"] = -1;
                        // set result to an invalid value as well
                        result = -1
                    }
                }
            }
            return result;
        }
    
    }


    function GapitSnmpNode(config) {
        RED.nodes.createNode(this, config);
        this.community = config.community;
        this.host = config.host;
        this.version = (config.version === "2c") ? snmp.Version2c : snmp.Version1;
        if (config.gapit_code) {
            this.gapit_code = JSON.parse(config.gapit_code);
        }
        this.scaling = config.scaling;
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

        this.scaler = new Scaling(this.scaling);

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
                        node.error("Request error: " + error.toString(), msg);
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
                                    node.error("OID/varbind error: " + snmp.varbindError(varbinds[i]), msg);
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
                                        
                                        if(groups[group_idx]["group"][member_idx]["byte_type"] != "STR") {
                                            // not a string, apply scaling
                                            groups[group_idx]["group"][member_idx]["value"] = 
                                                node.scaler.use_scaling(oid_value_map[oid], 
                                                                        groups[group_idx]["group"][member_idx]["scaling_factor"], 
                                                                        groups[group_idx]["group"][member_idx]["unit"], 
                                                                        groups[group_idx]["group"][member_idx]["description"]);
                                        }
                                        else {
                                            // no scaling for string values
                                            groups[group_idx]["group"][member_idx]["value"] = oid_value_map[oid];
                                        }
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
