
module.exports = function (RED) {
    "use strict";

    function GapitResultsToInfluxBatchNode(config) {
        RED.nodes.createNode(this,config);

        this.use_timestamp_from_msg = config.use_timestamp_from_msg;
        if (config.timestamp_property !== undefined) {
            this.timestamp_property = config.timestamp_property.trim();
        }
        else {
            this.timestamp_property = "";
        }

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
                        measurement_tmp.tags = JSON.parse(JSON.stringify(msg.db_tags)); // copy object
                        measurement_tmp.tags[msg.tagname_device_name] = groups_key;
                        if (groups_key in msg.custom_tags) {
                            // add minion-specific custom tags
                            for (const [minion_key, minion_val] of Object.entries(msg.custom_tags[groups_key])) {
                                console.debug("Adding custom (minion-specific) tag " + minion_key + ": " + minion_val)
                                measurement_tmp.tags[minion_key] = minion_val;
                            }
                        }
                        if (node.use_timestamp_from_msg) {
                            if (node.timestamp_property.length > 0) {
                                if (! isNaN(msg[node.timestamp_property])) {
                                    measurement_tmp.timestamp = msg[node.timestamp_property];
                                }
                                else if (msg[node.timestamp_property] === undefined) {
                                    node.error(`Node is configured to use timestamp from Message[${node.timestamp_property}], but the property is not set.`);
                                    return;
                                }
                                else {
                                    node.error(`Node is configured to use timestamp from Message[${node.timestamp_property}], but this property is not set to a number (value: ${msg[node.timestamp_property]}).`);
                                    return;
                                }
                                //else if nan, else if undefined
                            }
                            else {
                                node.error("Node is configured to use timestamp from Message, but the *Timestamp property* is not configured.");
                                return;
                            }
                        }
                        else {
                            console.debug("Not sending timestamp with data (influxdb will use its current timestamp)")
                        }
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
