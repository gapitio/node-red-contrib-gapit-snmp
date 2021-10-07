# General

An SNMP plugin which can take a *gapit config* as input, as oppsosed 
to manually specifiying OIDs.

Parse/use gapit SNMP config, and snmp get all OIDs listed in config. 
By default, stop querying OIDs for which "does not exist" is returned. 
Results are returned in a similar format to the input format, e.g. 
with group/stat names, and adjusted for specified scaling factors.

# Setup (node edit dialog)

* Same options as general snmp (server, community, etc.).
* A JSON text field for pasting a gapit config.
* Alternatively, the gapit config can be passed in the msg object, 
 overriding the text field (msg.gapit_config).
* A checkbox for "Keep querying non-existing OIDs" (also with a 
 msg.requery_nonexisting_oids).

# Internals

Keep track of OID avilability (i.e. which nodes return data, and which 
return "OID does not exist") in *node context*. Unless "Keep quierying" 
is set, stop querying unavailable OIDs. (This option is to account for 
instances where OIDs are ephemeral.)

It is possible to *get* more than one OID at a time, however, for SNMPv1, 
a single error will cause the entire query to fail. Use separate logic:

*SNMPv1* - query one OID at a time.
*SNMPv2+* - query all OIDs at once.
