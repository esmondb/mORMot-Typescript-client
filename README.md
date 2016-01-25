# mORMot-Typescript-client

This provides a typescript/javascript client for mORMot (www.synopse.info). It takes the ORM out of mORMot leaving just the mot. But should be useful for SOA calls to a server and CRUD.

Basic usage:

var SynopseClient = new mORMot.Client();<br>
SynopseClient.logIn('myserver.com', 'myname', 'mypassword');<br>
SynopseClient.post('myservice', 'mydata');<br>
SynopseClient.logout();



Documentation is sparse at the moment but source code should explain more.
