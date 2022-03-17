
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


    function varbindsParseCounter64Buffers(varbinds, convertToNumbers=true) {
        // Counter64 is not directly supported by net-snmp, 
        // but returned as a buffer (array). This function 
        // converts any Counter64 buffers in a varbinds object 
        // to a Number. The returned buffer is variable length 
        // (as big as needed to represent the number), while a 
        // BigInt is 8 bytes, and the function used expects this 
        // exact buffer length, so the buffer needs to be 
        // padded before it can be read as a BigInt.
        //
        // Based on code from 
        // https://discourse.nodered.org/t/snmp-access-problem/45990/9
        //
        // If convertToNumbers is set, the BigInt is converted 
        // to Number (if possible).

        for (const varbind of varbinds) {
            // ignore other data types
            if(varbind.type !== snmp.ObjectType.Counter64) continue;
            
            let inputBuffer = varbind.value;

            // Counter64 is unsigned, but the underlying ASN.1 
            // integer in SNMP is signed, so a "full" Counter64 
            // will be represented by 9 bytes. Remove the leading 
            // (sign) byte in this case.
            if (inputBuffer.length == 9) {
                inputBuffer = inputBuffer.slice(1);
            }

            // pad and parse buffer
            let padBuffer = Buffer.alloc(8 - inputBuffer.length);
            let bigBuffer = Buffer.concat([padBuffer, inputBuffer]);
            varbind.bufferValue = varbind.value

            let big = bigBuffer.readBigUInt64BE();
            if (convertToNumbers && big < Number.MAX_SAFE_INTEGER) {
                varbind.value = Number(big);
            }
            else {
                varbind.value = big;
            }
        }
    }


    function getGapitCodeResultsStructure(gapit_code) {
        // Create a copy of gapit_code for storing results.
        //
        // Remove keys which should be runtime data, which 
        // may be present in older JSON files.

        const group_remove_keys = ["next_read"];
        const member_remove_keys = ["value"];

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
        constructor(name, convertBigintToNumber=true) {
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
            this.convertBigintToNumber = convertBigintToNumber;
        }

        _init_scaling_schleifenbauer() {
            this.registers = Object();
            // each register field_name set needs its own set of registers
            // these are lazy initialized when the first register of a 
            // field_name is used
        }

        factorToDivisorInt(factor) {
            // turn a factor into a divisor, 
            // _if_ it turns out an integer
            // otherwise, return 1
            let divisor = 1 / factor;
            if (Math.ceil(divisor) != divisor) {
                // floating-point arithmetic handling
                // 1/0.0001  == 10000
                // 1/0.00001 == 99999.99999... - ceil to get the expected 100000
                if (String(Math.ceil(divisor)).endsWith('000')) {
                    console.debug('Divisor must be ceil\'ed, but assumed safe');
                    divisor = Math.ceil(divisor);
                }
                else {
                    divisor = 1;
                }
            }
            return divisor;
        }

        simple_scaling(value, scaling_factor, unit, field_name) {
            if ((typeof value !== "number" && typeof value !== "bigint") || typeof scaling_factor !== "number" || scaling_factor == 1) {
                if (scaling_factor == 1) {
                    console.debug("scaling_factor == 1, returning unchanged value");
                }
                else {
                    console.debug("Value or scaling_factor is not a number, returning unchanged value");
                }
                return value;
            }

            if (typeof value === "number") {
                // cast to string with 8 decimals, and convert back to number
                // this is to avoid numbers like 49.900000000000006 (from 499 * 0.1)
                var result = Number((value * scaling_factor).toFixed(8));
                console.debug(`Applied scaling to value ${value} with factor ${scaling_factor}, for result ${result}`);
                return result;
            }
            else if (typeof value === "bigint") {
                if (scaling_factor < 1) {
                    // a BigInt can't be multiplied with a fractional number, 
                    // so flip (1/n) the scaling_factor and divide instead
                    let divisor = this.factorToDivisorInt(scaling_factor);
                    if (divisor == 1) {
                        console.error(`Factor ${scaling_factor} cannot be turned into an (integer) divisor for use with BigInt, returning unchanged value`);
                        return value;
                    }
                    var result = value / BigInt(divisor);
                }
                else {
                    // scaling_factor > 1
                    var result = value * BigInt(scaling_factor);
                }
                if (this.convertBigintToNumber && result < Number.MAX_SAFE_INTEGER) {
                    result = Number(result);
                }
                console.debug(`Applied scaling to value ${value} with factor ${scaling_factor}, for result ${result}`);
                return result;
            }
        }
        
        _scaling_general(value, scaling_factor, unit, field_name) {
            console.debug(`Applying scaling to value ${value} with scaling factor ${scaling_factor}`);
            return this.simple_scaling(value, scaling_factor, unit, field_name);
        }

        _scaling_schleifenbauer(value, scaling_factor, unit, field_name) {
            console.debug(`Decoding Schleifenbauer with value ${value} and scaling factor ${scaling_factor}`);
            var result = this.simple_scaling(value, scaling_factor, unit, field_name);

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

                if (unit != "register4") 
                    // register 1/2/3, persist value for later sum
                    //
                    // if a "register5" or "registerBob" exists in gapit code, 
                    // it would also be persisted, but it won't be used to 
                    // calculate the sum anyway
                    this.registers[common_field_name][unit] = result;
                else {
                    // unit == register4
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
        this.blockTuningSteps = 10;
        this.config = config;
        this.multi_device_separator = ";";
        this.version = (config.version === "2c") ? snmp.Version2c : snmp.Version1;
        this.tagname_device_name = config.tagname_device_name.trim();
        this.tagvalue_device_name = config.tagvalue_device_name.trim();
        // split device_name from config into an array
        this.device_names = this.tagvalue_device_name.split(this.multi_device_separator);
        // split minion_ids from config into an array
        // splitting an empty string yields an array with 
        // one empty string, so check length of string
        if (config.minion_ids.trim().length > 0) {
            this.minion_ids = config.minion_ids.trim().split(this.multi_device_separator);
        } 
        else { 
            this.minion_ids = Array(); 
        }
        // parse custom tags JSON if present in config
        if (config.custom_tags) {
            this.custom_tags = JSON.parse(config.custom_tags);
        }
        else {
            this.custom_tags = Object();
        }
        // parse Gapit code JSON if present in config
        if (config.gapit_code) {
            config.gapit_code = JSON.parse(config.gapit_code);
        }
        this.scaling = config.scaling;
        this.timeout = Number(config.timeout || 5) * 1000;
        // set up mapping from device_name to minion_id
        this.device_name_to_minion_id = Object();
        if (this.minion_ids.length > 0) {
            if (this.minion_ids.length != this.device_names.length) {
                this.error("'Device name' and 'Minion IDs' must contain the same number of items");
            }
            for (const [i, devname] of Object.entries(this.device_names)) {
                this.device_name_to_minion_id[devname] = this.minion_ids[i];
            }
        }
        else {
            // single device, no minion id
            // minion_id = -1 to indicate that minion id replacement 
            // should not be performed on OIDs.
            this.device_name_to_minion_id[this.device_names[0]] = -1;
        }
        // add db tags from config to node
        this.db_tags = {}
        for (const [key, val] of Object.entries(config)) {
            if (key.startsWith("tagname_") && key != "tagname_device_name") { 
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
        // add custom tags for all minions, or when no minions are 
        // specified. minion-specific tags must be processed later, 
        // e.g. in gapit-results-to-influx-batch node.
        for (const [root_key, root_val] of Object.entries(this.custom_tags)) {
            if (this.minion_ids.length == 0) {
                // no minions, add tags from root
                console.debug("Adding custom tag " + root_key + ": " + root_val)
                this.db_tags[root_key] = root_val;
            }
            else if (root_key == "all-minion-tags") {
                for (const [minion_key, minion_val] of Object.entries(root_val)) {
                    console.debug("Adding custom (all-minion) tag " + minion_key + ": " + minion_val)
                    this.db_tags[minion_key] = minion_val;
                }
            }
        }

        this.scaler = new Scaling(this.scaling, this.config.convert_counter64_bigint_to_number);

        var node = this;

        // get context
        var nodeContext = node.context();
        // initialize nonexistent_oids in context
        console.info("initializing nonexistent_oids in context (set to empty Array)")
        nodeContext.set("nonexistent_oids", Array());

        this.processVarbinds = function (msg, varbinds) {
            // parse Counter64 values in varbinds
            varbindsParseCounter64Buffers(varbinds, node.config.convert_counter64_bigint_to_number);

            // get result structure
            var gapit_results = getGapitCodeResultsStructure(msg.gapit_code);

            var varbinds_to_delete = Array();
            for (var i = 0; i < varbinds.length; i++) {
                if (snmp.isVarbindError(varbinds[i])) {
                    if (varbinds[i].type == snmp.ObjectType.NoSuchInstance || 
                        varbinds[i].type == snmp.ObjectType.NoSuchObject) {
                        // example code uses snmp.ErrorStatus.NoSuchInstance, 
                        // but it is actually snmp.ObjectType.NoSuchInstance
                        node.warn("OID '" + varbinds[i]["oid"] + "' is not present")
                        // remove varbinds with these errors, instead of throwing an error
                        // build list of indexes to delete after iteration is complete
                        varbinds_to_delete.push(i);
                        // add to context "nonexistent_oids" array if not already there, 
                        // so the OID can be skipped in the next query
                        node.addNonExistentOid(varbinds[i]["oid"]);
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

            node.persistNonExistentOids();

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
            for (const [groups_key, groups] of Object.entries(gapit_results)) {
                for (var group_idx = 0; group_idx < groups.length; group_idx++) { 
                    // iterate array in reverse, to enable deletion
                    for (var member_idx = groups[group_idx]["group"].length - 1; member_idx >= 0 ; member_idx--) { 
                        var oid = groups[group_idx]["group"][member_idx]["address"];
                        if (oid in oid_value_map) {
                            groups[group_idx]["group"][member_idx]["value"] = oid_value_map[oid];
                        }
                        else if (node.config.remove_novalue_items_from_gapit_results) {
                            groups[group_idx]["group"].splice(member_idx, 1);
                            //node.warn("should delete this");
                        }
                    }

                    // apply scaling
                    // for certain scaling methods (e.g. Schleifenbauer), the scaling 
                    // needs to be applied in the defined gapit_code order, hence a 
                    // separate loop for scaling.
                    for (var member_idx = 0; member_idx < groups[group_idx]["group"].length ; member_idx++) { 
                        if(("value" in groups[group_idx]["group"][member_idx]) 
                                && groups[group_idx]["group"][member_idx]["byte_type"] != "STR") {
                            // value is set, and not a string, apply scaling
                            groups[group_idx]["group"][member_idx]["value"] = 
                                node.scaler.use_scaling(groups[group_idx]["group"][member_idx]["value"], 
                                                        groups[group_idx]["group"][member_idx]["scaling_factor"], 
                                                        groups[group_idx]["group"][member_idx]["unit"], 
                                                        groups[group_idx]["group"][member_idx]["description"]);
                        }
                    }
                }
            };

            msg.db_tags = node.db_tags;
            msg.custom_tags = node.custom_tags;
            msg.tagname_device_name = node.tagname_device_name;
            msg.varbinds = varbinds;
            msg.oid_value_map = oid_value_map;
            msg.gapit_results = gapit_results;
            node.send(msg);
        }

        this.readNonExistentOids = function () {
            // get nonexistent_oids from context
            node.nonexistent_oids = nodeContext.get("nonexistent_oids");
            // flag to keep track of changes to nonexistent_oids
            node.nonexistent_oids_modified = false;
        }

        this.addNonExistentOid = function (oid) {
            if (node.config.skip_nonexistent_oids) {
                if (! node.nonexistent_oids.includes(oid)) {
                    node.nonexistent_oids.push(oid);
                    node.nonexistent_oids_modified = true;
                }
            }
        }

        this.isNonExistentOid = function (oid) {
            if (node.config.skip_nonexistent_oids) {
                return node.nonexistent_oids.includes(oid);
            }
            else {
                // skip_nonexistent_oids is disabled
                return false;
            }
        }

        this.persistNonExistentOids = function () {
            // if modified, save nonexistent_oids to context
            if (node.config.skip_nonexistent_oids) {
                if (node.nonexistent_oids_modified) {
                    nodeContext.set("nonexistent_oids", node.nonexistent_oids);
                }
            }
        }

        this.expandGapitCodeForMinions = function (msg) {
            // expand config to support querying for multiple minions.
            // modify gapit_config to have device_name as key, in place of "objects", 
            // with one copy of config per device_name.
            // 
            for (const device_name of node.device_names) {
                // in case of empty device names (;;)
                if(device_name.length > 0) {
                    console.debug(`Copying gapit_code["objects"] to gapit_code[${device_name}]`);
                    msg.gapit_code[device_name] = JSON.parse(JSON.stringify(msg.gapit_code["objects"]));
                    var minion_id = node.device_name_to_minion_id[device_name];
                    if (minion_id != -1) {
                        // miniond_id == -1 means minion_ids was not specified in node config
                        console.debug(`Replacing minion ID in OIDs for "${device_name}", id ${minion_id}`);
                        var groups = msg.gapit_code[device_name];
                        for (var group_idx = 0; group_idx < groups.length; group_idx++) {
                            for (var member_idx = 0; member_idx < groups[group_idx]["group"].length; member_idx++) { 
                                var oid = groups[group_idx]["group"][member_idx]["address"];
                                oid = oid.replace("x", minion_id);
                                groups[group_idx]["group"][member_idx]["address"] = oid;
                            }
                        }
                    }
                }
            }
            // remove original "objects" from gapit_code, leaving only 
            // device_name keys. even if tagvalue_device_name is required, 
            // it is still possible (with a warning) to deploy a flow 
            // without it, so first verify that there is more than one 
            // key present.
            if (Object.keys(msg.gapit_code).length > 1) {
                console.debug("Removing original gapit_code['objects']");
                delete msg.gapit_code["objects"];
            }
        }

        this.getNextRead = function (msg) {
            var next_read = nodeContext.get("next_read");
            // initialize next_read (set 0) if not present
            if (next_read === undefined) {
                console.debug("no next_read in context, initializing variable");
                next_read = Object();
                for (const [groups_key, groups] of Object.entries(msg.gapit_code)) {
                    next_read[groups_key] = Object();
                    for (var group_idx = 0; group_idx < groups.length; group_idx++) {
                        var group_name = groups[group_idx]["group_name"];
                        // console.log(`setting next_read for ${group_name}`);
                        next_read[groups_key][group_name] = 0;
                    }
                }
            }

            return next_read;
        }

        this.skipGroupThisRead = function (msg, groups_key, group_idx) {
            // check if this group should be skipped for this read, 
            // according to next_read
            var next_read = node.getNextRead(msg);
            var group_name = msg.gapit_code[groups_key][group_idx]["group_name"];
            var read_priority = msg.gapit_code[groups_key][group_idx]["read_priority"];
            var ts = Math.trunc(new Date().valueOf() / 1000);

            if (ts < next_read[groups_key][group_name] || read_priority == "n") {
                if (ts < next_read[groups_key][group_name]) {
                    var next_read_time = new Date(next_read[groups_key][group_name] * 1000).toLocaleTimeString();
                    console.debug(`Skipping group '${group_name}' until next_read time (${next_read_time})`);
                }
                else if (groups[group_idx]["read_priority"] == "n") {
                    console.debug(`Skipping group '${group_name}', read_priority == "n"`);
                }
                return true;
            }
            // default
            return false;
        }

        this.setNextReadForGroup = function (msg, groups_key, group_idx) {
            // set next_read
            var next_read = node.getNextRead(msg);
            var group_name = msg.gapit_code[groups_key][group_idx]["group_name"];
            var read_priority = msg.gapit_code[groups_key][group_idx]["read_priority"];
            var ts = Math.trunc(new Date().valueOf() / 1000);
            next_read[groups_key][group_name] = ts + read_priority;
            // save next_read to context
            nodeContext.set("next_read", next_read);
        }

        this.getOidsToQuery = function (msg) {
            var oids = Array()
            for (const [groups_key, groups] of Object.entries(msg.gapit_code)) {
                for (var group_idx = 0; group_idx < groups.length; group_idx++) { 
                    var group_name = groups[group_idx]["group_name"];

                    if (node.skipGroupThisRead(msg, groups_key, group_idx)) {
                        continue;
                    }

                    node.setNextReadForGroup(msg, groups_key, group_idx);
                    console.info("Getting OIDs from group '" + group_name + "'");
                    for (var member_idx = 0; member_idx < groups[group_idx]["group"].length; member_idx++) { 
                        var oid = groups[group_idx]["group"][member_idx]["address"];
                        console.info("Found OID " + oid + " for '" + groups[group_idx]["group"][member_idx]["description"] + "'");
                        if (node.isNonExistentOid(oid)) {
                            // oid does not exist, skip
                            continue;
                        }
                        // duplicate OIDs kill the SNMP request
                        if (oids.includes(oid)) {
                            // already in Array, skip
                            continue;
                        }
                        oids.push(oid);
                    }
                }
            };

            return oids;
        }

        this.snmpGetIndividualOids = function (host, community, oids, msg) {
            // Query OIDs individually
            // Workaround for SNMPv1 queries failing if one or more OIDS
            // don't exist.

            msg.v1QueryCount = oids.length;
            msg.v1ResponseCount = 0;
            msg.v1Varbinds = Array();
            for (const oid of oids) {
                console.debug(`SNMPv1 single-OID query for '${oid}'`);
                getSession(host, community, node.version, node.timeout).get([oid], function (singleQueryError, singleQueryVarbinds) {
                    msg.v1ResponseCount += 1;
                    console.debug(`Got SNMPv1 single-OID response #${msg.v1ResponseCount} of ${msg.v1QueryCount}`);
                    if (singleQueryError) {
                        if((singleQueryError.name == "RequestFailedError") && (singleQueryError.status == snmp.ErrorStatus.NoSuchName)) {
                            node.warn(`SNMPv1 single-OID query: OID '${oid}' is not present`);
                            node.addNonExistentOid(oid);
                        }
                        else {
                            node.error(`SNMPv1 single-OID request error: ${singleQueryError.toString()}`);
                        }
                    }
                    else {
                        console.debug(`Got result for SNMPv1 single-OID query for OID '${oid}'`);
                        msg.v1Varbinds.push(singleQueryVarbinds[0]);
                    }
                    if (msg.v1ResponseCount === msg.v1QueryCount) {
                        console.debug("Got responses for all SNMPv1 single-OID queries, processing results");
                        node.processVarbinds(msg, msg.v1Varbinds);
                    }
                });

                node.persistNonExistentOids();
            }
        }

        this.tuneSnmpBlockSize = function (host, community, oids, msg, blockSize) {
            getSession(host, community, node.version, node.timeout).get(oids.slice(0, blockSize), function (error, varbinds) {
                if (error) {
                    // error object has .name, .message and, optionally, .status
                    // error.status is only set for RequestFailed, so check
                    // that it's this error before checking the value of .status
                    if ((error.name == "RequestFailedError") && (error.status == snmp.ErrorStatus.TooBig)) {
                        // Adjust blockSize down one level, try again.
                        blockSize = blockSize - node.blockTuningSteps;
                        node.warn(`Still tooBig, trying again with ${blockSize} OIDs`);
                        node.tuneSnmpBlockSize(host, community, oids, msg, blockSize);
                    }
                    else if ((error.name == "RequestFailedError") && (error.status == snmp.ErrorStatus.NoSuchName)) {
                        // As soon as tooBig is no longer triggered, this error
                        // may occur.
                        //
                        // SNMPv1 NoSuchName
                        // A single "missing" OID causes an SNMPv1 query to fail, 
                        // query OIDs one by one as a workaround
                        node.warn("SNMPv1 NoSuchName, will query all OIDs individually");
                        node.snmpGetIndividualOids(host, community, oids, msg);
                    }
                    else {
                        node.error("Request error: " + error.toString(), msg);
                    }
                }
                else {
                    console.info(`Found working block size to work around SNMP tooBig error: ${blockSize} OIDs`);
                    // For testing, remove always-failing (in simulator) oid from list.
                    // oids.splice(oids.indexOf("1.3.6.1.4.1.534.1.9.7.0"), 1);
                    // 
                    // node.snmpGetByBlock(host, community, oids, msg, blockSize);
                    // node.getBlockSize = blockSize;
                }
            });
        }

        this.snmpGet = function (host, community, oids, msg) {
            getSession(host, community, node.version, node.timeout).get(oids, function (error, varbinds) {
                if (error) {
                    // error object has .name, .message and, optionally, .status
                    // error.status is only set for RequestFailed, so check
                    // that it's this error before checking the value of .status
                    if ((error.name == "RequestFailedError") && (error.status == snmp.ErrorStatus.NoSuchName)) {
                        // SNMPv1 NoSuchName
                        // A single "missing" OID causes an SNMPv1 query to fail, 
                        // query OIDs one by one as a workaround
                        node.warn("SNMPv1 NoSuchName, will query all OIDs individually");
                        node.snmpGetIndividualOids(host, community, oids, msg);
                    }
                    else if ((error.name == "RequestFailedError") && (error.status == snmp.ErrorStatus.TooBig)) {
                        // SNMP tooBig -- too many OIDs for a single request
                        // Request must be broken into several bulked requests.
                        // Set an initial bulk size, then let tuneSnmpBlockSize() 
                        // handle further adjustments.
                        let blockSize = oids.length - node.blockTuningSteps - (oids.length % node.blockTuningSteps);
                        node.warn(`SNMP tooBig error, divide into multiple requests for blocks of OIDS, first attempt: ${blockSize} OIDs`);
                        node.tuneSnmpBlockSize(host, community, oids, msg, blockSize);
                    }
                    else {
                        node.error("Request error: " + error.toString(), msg);
                    }
                }
                else {
                    node.processVarbinds(msg, varbinds);
                }
            });
        }

        this.on("input", function (msg) {
            node.readNonExistentOids();

            // deep copy gapit_code, so this variable can be modified without affecting config object
            msg.gapit_code = JSON.parse(JSON.stringify(node.config.gapit_code || msg.gapit_code));

            // if multiple minions are specified, verify that the 
            // number of device names matches the number of minions
            if (node.minion_ids.length > 0 && node.minion_ids.length != node.device_names.length) {
                node.error("'Device name' and 'Minion IDs' must contain the same number of items");
                return;
            }

            node.expandGapitCodeForMinions(msg);

            // build list of OIDs
            var oids = node.getOidsToQuery(msg)

            if (oids.length > 0) {
                node.snmpGet(node.config.host, node.config.community, oids, msg);
            }
            else {
                node.warn("No oid(s) to search for");
            }
        });
    }
    RED.nodes.registerType("gapit-snmp", GapitSnmpNode);
};
