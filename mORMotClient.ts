module mORMot {
  function getXhr(): XMLHttpRequest {
    for(var i=0; i<4; i++){
      try{
        return i ?
          new ActiveXObject([, "Msxml2", "Msxml3", "Microsoft"][i] + ".XMLHTTP")
          : new XMLHttpRequest;
      }
      catch(e){
        // ignore when it fails.
      }
    }
  }

  export interface serverResposeCallback {
    (HTTPstatus: number, response: string, passedOptions?: Object): any;
  }

  export interface logInOutCallback {
    (success: boolean, HTTPstatus: number, response: string, passedOptions?: Object): void;
  }

  export interface retrieveRecordCallback {
    (HTTPstatus: number, data:{}): void;
  }

  export interface addRecordCallback {
    (HTTPstatus: number, table: string, recordID: number): void;
  }

  export interface mORMotObject {ID: number}
 
  export class Client {
    public User : string = "";
    private Root : string = "";
    private ServerURL : string = "";
    public loggedIn : boolean = false;
    public groupID : number = 0;
    private SessionID : number = 0;
    private SessionIDHexa8 : string = "";
    private SessionPrivateKey : number = 0;
    private SessionTickCountOffset : number = 0;
    private PasswordHashHexa : string = "";
    private ServerTimeStampOffset : number = 0;
    private LoginCallback : logInOutCallback;
    private LogoutCallback : logInOutCallback;
    private RetryLogin: boolean = true; // used in case of login timeout 403
    private LoginPassedOptions: Object;
    private GET_HTTP_VERB : string = 'GET';
    private PUT_HTTP_VERB : string = 'PUT';
    private POST_HTTP_VERB : string = 'POST';
    private LOCK_HTTP_VERB : string = 'LOCK';
    private READY_STATUS_CODE : number = 4;
    private isCompleted(request: XMLHttpRequest) { 
      return request.readyState === this.READY_STATUS_CODE;
    }

    //
    //   hexadecimal representation of a number
    //   (note toString(16) is implementation-dependant, and
    //   in IE returns signed numbers when used on full words)
    //
    private Sha256toHexStr(n: number): string{
      var s="", v, i;
      for (i=7; i>=0; i = i -1) { v = (n>>>(i*4)) & 0xf; s += v.toString(16); }
      return s;
    }

    /* - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -  */
    /*  Utf8 class: encode / decode between multi-byte Unicode characters and UTF-8 multiple          */
    /*              single-byte character encoding (c) Chris Veness 2002-2010                         */
    /* - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -  */

    /**
     * Encode multi-byte Unicode string into utf-8 multiple single-byte characters
     * (BMP / basic multilingual plane only)
     *
     * Chars in range U+0080 - U+07FF are encoded in 2 chars, U+0800 - U+FFFF in 3 chars
     *
     * @param {String} strUni Unicode string to be encoded as UTF-8
     * @returns {String} encoded string
     */
    private Utf8encode(strUni: string): string {
      // use regular expressions & String.replace callback function for better efficiency
      // than procedural approaches
      var strUtf = strUni.replace(
          /[\u0080-\u07ff]/g,  // U+0080 - U+07FF => 2 bytes 110yyyyy, 10zzzzzz
          function(c) {
            var cc = c.charCodeAt(0);
            return String.fromCharCode(0xc0 | cc>>6, 0x80 | cc&0x3f); }
        );
      strUtf = strUtf.replace(
          /[\u0800-\uffff]/g,  // U+0800 - U+FFFF => 3 bytes 1110xxxx, 10yyyyyy, 10zzzzzz
          function(c) {
            var cc = c.charCodeAt(0);
            return String.fromCharCode(0xe0 | cc>>12, 0x80 | cc>>6&0x3F, 0x80 | cc&0x3f); }
        );
      return strUtf;
    }

    /**
     * Decode utf-8 encoded string back into multi-byte Unicode characters
     *
     * @param {String} strUtf UTF-8 string to be decoded back to Unicode
     * @returns {String} decoded string
     */
    private Utf8decode(strUtf: string): string {
      // note: decode 3-byte chars first as decoded 2-byte strings could appear to be 3-byte char!
      var strUni = strUtf.replace(
          /[\u00e0-\u00ef][\u0080-\u00bf][\u0080-\u00bf]/g,  // 3-byte chars
          function(c) {  // (note parentheses for precence)
            var cc = ((c.charCodeAt(0)&0x0f)<<12) | ((c.charCodeAt(1)&0x3f)<<6) | ( c.charCodeAt(2)&0x3f);
            return String.fromCharCode(cc); }
        );
      strUni = strUni.replace(
          /[\u00c0-\u00df][\u0080-\u00bf]/g,                 // 2-byte chars
          function(c) {  // (note parentheses for precence)
            var cc = (c.charCodeAt(0)&0x1f)<<6 | c.charCodeAt(1)&0x3f;
            return String.fromCharCode(cc); }
        );
      return strUni;
    }

    private Sha256ROTR(n, x) { return (x >>> n) | (x << (32-n)); }
    private Sha256Sigma0(x) { return this.Sha256ROTR(2,  x) ^ this.Sha256ROTR(13, x) ^ this.Sha256ROTR(22, x); }
    private Sha256Sigma1(x) { return this.Sha256ROTR(6,  x) ^ this.Sha256ROTR(11, x) ^ this.Sha256ROTR(25, x); }
    private Sha256sigma0(x) { return this.Sha256ROTR(7,  x) ^ this.Sha256ROTR(18, x) ^ (x>>>3);  }
    private Sha256sigma1(x) { return this.Sha256ROTR(17, x) ^ this.Sha256ROTR(19, x) ^ (x>>>10); }
    private Sha256Ch(x, y, z)  { return (x & y) ^ (~x & z); }
    private Sha256Maj(x, y, z) { return (x & y) ^ (x & z) ^ (y & z); }

    private Sha256hash(msg: string, utf8encode?: boolean): string {
      var K,H,l,N,M,i,j,W,a, b, c, d, e, f, g, h, t, T1, T2;
      utf8encode =  (typeof utf8encode == 'undefined') ? true : utf8encode;
      // convert string to UTF-8, as SHA only deals with byte-streams
      if (utf8encode) {msg = this.Utf8encode(msg);}
      // constants [§4.2.2]
      K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
           0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
           0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
           0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
           0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
           0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
           0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
           0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
      // initial hash value [§5.3.1]
      H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

      // PREPROCESSING      
      msg += String.fromCharCode(0x80);  // add trailing '1' bit (+ 0's padding) to string [§5.1.1]

      // convert string msg into 512-bit/16-integer blocks arrays of ints [§5.2.1]
      l = msg.length/4 + 2;  // length (in 32-bit integers) of msg + ‘1’ + appended length
      N = Math.ceil(l/16);   // number of 16-integer-blocks required to hold 'l' ints
      M = [N];//new Array(N);

      for (i=0; i<N; i = i+1) {
          M[i] = new Array(16);
          for (j=0; j<16; j = j +1) {  // encode 4 chars per integer, big-endian encoding
              M[i][j] = (msg.charCodeAt(i*64+j*4)<<24) | (msg.charCodeAt(i*64+j*4+1)<<16) |
                        (msg.charCodeAt(i*64+j*4+2)<<8) | (msg.charCodeAt(i*64+j*4+3));
          } // note running off the end of msg is ok 'cos bitwise ops on NaN return 0
      }
      // add length (in bits) into final pair of 32-bit integers (big-endian) [§5.1.1]
      // note: most significant word would be (len-1)*8 >>> 32, but since JS converts
      // bitwise-op args to 32 bits, we need to simulate this by arithmetic operators
      M[N-1][14] = ((msg.length-1)*8) / Math.pow(2, 32); M[N-1][14] = Math.floor(M[N-1][14]);
      M[N-1][15] = (((msg.length-1)*8) & 0xffffffff);

      // HASH COMPUTATION [§6.1.2]

      W = new Array(64);
      for (i=0; i<N; i = i+1) {

        // 1 - prepare message schedule 'W'
        for (t=0;  t<16; t = t+1) {W[t] = M[i][t];}
        for (t=16; t<64; t = t+1) {W[t] = (this.Sha256sigma1(W[t-2]) + W[t-7] + this.Sha256sigma0(W[t-15]) + W[t-16]) & 0xffffffff;}

        // 2 - initialise working variables a, b, c, d, e, f, g, h with previous hash value
        a = H[0]; b = H[1]; c = H[2]; d = H[3]; e = H[4]; f = H[5]; g = H[6]; h = H[7];

        // 3 - main loop (note 'addition modulo 2^32')
        for (t=0; t<64; t = t+1) {
          T1 = h + this.Sha256Sigma1(e) + this.Sha256Ch(e, f, g) + K[t] + W[t];
          T2 = this.Sha256Sigma0(a) + this.Sha256Maj(a, b, c);
          h = g;
          g = f;
          f = e;
          e = (d + T1) & 0xffffffff;
          d = c;
          c = b;
          b = a;
          a = (T1 + T2) & 0xffffffff;
        }
         // 4 - compute the new intermediate hash value (note 'addition modulo 2^32')
        H[0] = (H[0]+a) & 0xffffffff;
        H[1] = (H[1]+b) & 0xffffffff;
        H[2] = (H[2]+c) & 0xffffffff;
        H[3] = (H[3]+d) & 0xffffffff;
        H[4] = (H[4]+e) & 0xffffffff;
        H[5] = (H[5]+f) & 0xffffffff;
        H[6] = (H[6]+g) & 0xffffffff;
        H[7] = (H[7]+h) & 0xffffffff;
      }

      return this.Sha256toHexStr(H[0]) + this.Sha256toHexStr(H[1]) + this.Sha256toHexStr(H[2]) + this.Sha256toHexStr(H[3]) +
             this.Sha256toHexStr(H[4]) + this.Sha256toHexStr(H[5]) + this.Sha256toHexStr(H[6]) + this.Sha256toHexStr(H[7]);
    }

    /*
      CRC-32 (as it is in ZMODEM) in table form

      Copyright (C) 1986 Gary S. Brown. You may use this program, or
      code or tables extracted from it, as desired without restriction.

      Modified by Anders Danielsson, February 5, 1989 and March 10, 2006.

      This is also known as FCS-32 (as it is in PPP), described in
      RFC-1662 by William Allen Simpson, see RFC-1662 for references.
    */
    private Crc32Tab = [ /* CRC polynomial 0xEDB88320 */
    0x00000000,0x77073096,0xEE0E612C,0x990951BA,0x076DC419,0x706AF48F,0xE963A535,0x9E6495A3,
    0x0EDB8832,0x79DCB8A4,0xE0D5E91E,0x97D2D988,0x09B64C2B,0x7EB17CBD,0xE7B82D07,0x90BF1D91,
    0x1DB71064,0x6AB020F2,0xF3B97148,0x84BE41DE,0x1ADAD47D,0x6DDDE4EB,0xF4D4B551,0x83D385C7,
    0x136C9856,0x646BA8C0,0xFD62F97A,0x8A65C9EC,0x14015C4F,0x63066CD9,0xFA0F3D63,0x8D080DF5,
    0x3B6E20C8,0x4C69105E,0xD56041E4,0xA2677172,0x3C03E4D1,0x4B04D447,0xD20D85FD,0xA50AB56B,
    0x35B5A8FA,0x42B2986C,0xDBBBC9D6,0xACBCF940,0x32D86CE3,0x45DF5C75,0xDCD60DCF,0xABD13D59,
    0x26D930AC,0x51DE003A,0xC8D75180,0xBFD06116,0x21B4F4B5,0x56B3C423,0xCFBA9599,0xB8BDA50F,
    0x2802B89E,0x5F058808,0xC60CD9B2,0xB10BE924,0x2F6F7C87,0x58684C11,0xC1611DAB,0xB6662D3D,
    0x76DC4190,0x01DB7106,0x98D220BC,0xEFD5102A,0x71B18589,0x06B6B51F,0x9FBFE4A5,0xE8B8D433,
    0x7807C9A2,0x0F00F934,0x9609A88E,0xE10E9818,0x7F6A0DBB,0x086D3D2D,0x91646C97,0xE6635C01,
    0x6B6B51F4,0x1C6C6162,0x856530D8,0xF262004E,0x6C0695ED,0x1B01A57B,0x8208F4C1,0xF50FC457,
    0x65B0D9C6,0x12B7E950,0x8BBEB8EA,0xFCB9887C,0x62DD1DDF,0x15DA2D49,0x8CD37CF3,0xFBD44C65,
    0x4DB26158,0x3AB551CE,0xA3BC0074,0xD4BB30E2,0x4ADFA541,0x3DD895D7,0xA4D1C46D,0xD3D6F4FB,
    0x4369E96A,0x346ED9FC,0xAD678846,0xDA60B8D0,0x44042D73,0x33031DE5,0xAA0A4C5F,0xDD0D7CC9,
    0x5005713C,0x270241AA,0xBE0B1010,0xC90C2086,0x5768B525,0x206F85B3,0xB966D409,0xCE61E49F,
    0x5EDEF90E,0x29D9C998,0xB0D09822,0xC7D7A8B4,0x59B33D17,0x2EB40D81,0xB7BD5C3B,0xC0BA6CAD,
    0xEDB88320,0x9ABFB3B6,0x03B6E20C,0x74B1D29A,0xEAD54739,0x9DD277AF,0x04DB2615,0x73DC1683,
    0xE3630B12,0x94643B84,0x0D6D6A3E,0x7A6A5AA8,0xE40ECF0B,0x9309FF9D,0x0A00AE27,0x7D079EB1,
    0xF00F9344,0x8708A3D2,0x1E01F268,0x6906C2FE,0xF762575D,0x806567CB,0x196C3671,0x6E6B06E7,
    0xFED41B76,0x89D32BE0,0x10DA7A5A,0x67DD4ACC,0xF9B9DF6F,0x8EBEEFF9,0x17B7BE43,0x60B08ED5,
    0xD6D6A3E8,0xA1D1937E,0x38D8C2C4,0x4FDFF252,0xD1BB67F1,0xA6BC5767,0x3FB506DD,0x48B2364B,
    0xD80D2BDA,0xAF0A1B4C,0x36034AF6,0x41047A60,0xDF60EFC3,0xA867DF55,0x316E8EEF,0x4669BE79,
    0xCB61B38C,0xBC66831A,0x256FD2A0,0x5268E236,0xCC0C7795,0xBB0B4703,0x220216B9,0x5505262F,
    0xC5BA3BBE,0xB2BD0B28,0x2BB45A92,0x5CB36A04,0xC2D7FFA7,0xB5D0CF31,0x2CD99E8B,0x5BDEAE1D,
    0x9B64C2B0,0xEC63F226,0x756AA39C,0x026D930A,0x9C0906A9,0xEB0E363F,0x72076785,0x05005713,
    0x95BF4A82,0xE2B87A14,0x7BB12BAE,0x0CB61B38,0x92D28E9B,0xE5D5BE0D,0x7CDCEFB7,0x0BDBDF21,
    0x86D3D2D4,0xF1D4E242,0x68DDB3F8,0x1FDA836E,0x81BE16CD,0xF6B9265B,0x6FB077E1,0x18B74777,
    0x88085AE6,0xFF0F6A70,0x66063BCA,0x11010B5C,0x8F659EFF,0xF862AE69,0x616BFFD3,0x166CCF45,
    0xA00AE278,0xD70DD2EE,0x4E048354,0x3903B3C2,0xA7672661,0xD06016F7,0x4969474D,0x3E6E77DB,
    0xAED16A4A,0xD9D65ADC,0x40DF0B66,0x37D83BF0,0xA9BCAE53,0xDEBB9EC5,0x47B2CF7F,0x30B5FFE9,
    0xBDBDF21C,0xCABAC28A,0x53B39330,0x24B4A3A6,0xBAD03605,0xCDD70693,0x54DE5729,0x23D967BF,
    0xB3667A2E,0xC4614AB8,0x5D681B02,0x2A6F2B94,0xB40BBE37,0xC30C8EA1,0x5A05DF1B,0x2D02EF8D];

    private Crc32Add(crc,c)
    /*
      'crc' should be initialized to 0xFFFFFFFF and after the computation it should be
      complemented (inverted).

      CRC-32 is also known as FCS-32.

      If the FCS-32 is calculated over the data and over the complemented FCS-32, the
      result will always be 0xDEBB20E3 (without the complementation).
    */
    {
      return this.Crc32Tab[(crc^c)&0xFF]^((crc>>8)&0xFFFFFF);
    }

    private crc32(str, crc){
      var n, len;
      len = str.length;
      //var crc;
      if (typeof(crc) == "undefined") { crc = 0xFFFFFFFF; }
      else {
        crc = crc^0xFFFFFFFF; //crc = ~crc;
        if (crc < 0) {
          crc = 4294967296 + crc;
        } 
      }
      //crc=0xFFFFFFFF;
      for (n=0; n<len; n = n+1) {
        crc = this.Crc32Add(crc,str.charCodeAt(n));
      }
      crc = crc^0xFFFFFFFF; //crc = ~crc;
      if (crc < 0) {
        crc = 4294967296 + crc;
      } 
      return crc;//^0xFFFFFFFF;
    }

    private httpRequest(url: string, httpVerb: string, sendData: any, callback?: serverResposeCallback, asynchronous?: boolean){
      var XHR: XMLHttpRequest = getXhr();
      XHR.onreadystatechange = () => {
        var This = this;
        if (This.isCompleted(XHR)) {
          if (callback) {
            callback.call(This, XHR.status, (httpVerb !== This.POST_HTTP_VERB) ? XHR.responseText : XHR.getResponseHeader('Location'));
          }
        }
      };
      if ( asynchronous !== false ) { asynchronous = true; }
      XHR.open(httpVerb, url, asynchronous);
      if ((httpVerb === this.POST_HTTP_VERB)||(httpVerb === this.PUT_HTTP_VERB)) {
        XHR.setRequestHeader("Content-type","application/json");
      }
      XHR.send(sendData);
      if (!asynchronous) {
        return XHR.status;
      }
    }

    private onGotSession(status: number, response: string) { //final part of log in process
      var This = this, i: number, data;
      if (status !== 200) {
        if(This.LoginCallback instanceof Function) {
          This.LoginCallback(false, status, response);
        }
      } else {
        data = JSON.parse(response);
        i = data.result.indexOf("+");
        This.SessionID = parseInt(data.result.slice(0, i), 10);
        This.SessionIDHexa8 = This.SessionID.toString(16);
        while(This.SessionIDHexa8.length < 8) { This.SessionIDHexa8 = '0'+This.SessionIDHexa8; }
        This.loggedIn = true;
        This.groupID = data.logongroup;
        This.SessionPrivateKey = This.crc32(This.PasswordHashHexa, This.crc32(data.result, 0));
        if (This.LoginCallback instanceof Function) {
          This.LoginCallback(true, status, response, This.LoginPassedOptions);
          This.RetryLogin = true;
        }
      }
    }

    private onGotNonce(status: number, response: string){
      var This = this;
      if (status !== 200) {
        if(This.LoginCallback instanceof Function) {
          This.LoginCallback(false, status, response);
        }
      } else {
        //create client nonce
        var aClientNonce = "", s: string = "", d = new Date();
        aClientNonce = d.getFullYear().toString();
        s = d.getMonth().toString();
        if (s.length === 1) { s = '0'+s;}
        aClientNonce = aClientNonce + '-' + s;
        s = d.getDate().toString();
        if (s.length === 1) { s = '0'+s;}
        aClientNonce = aClientNonce + '-' + s + ' ';
        s = d.getHours().toString();
        if (s.length === 1) { s = '0'+s;}
        aClientNonce = aClientNonce + s;
        s = d.getMinutes().toString();
        if (s.length === 1) { s = '0'+s;}
        aClientNonce = aClientNonce + ':' + s;
        s = d.getSeconds().toString();
        if (s.length === 1) { s = '0'+s;}
        aClientNonce = aClientNonce + ':' + s;
        aClientNonce = This.Sha256hash(aClientNonce);
        var data = JSON.parse(response);
        s = This.ServerURL + "/"+This.Root+"/Auth?UserName="+This.User+"&Password=" + 
            This.Sha256hash(This.Root+data.result+aClientNonce+This.User+This.PasswordHashHexa) + 
            "&ClientNonce="+aClientNonce;
        This.httpRequest(s, This.GET_HTTP_VERB, null, This.onGotSession);
      }
    }

    private nowAsMormotTime():number {
      var s: string, d = new Date(), mTime: string = '';
      s = d.getFullYear().toString(2);
      while(s.length < 13) { s = '0'+s;}
      mTime = s;
      s = d.getMonth().toString(2);
      while(s.length < 4) { s = '0'+s;}
      mTime = mTime +s;
      s = (d.getDate()-1).toString(2);
      while(s.length < 5) { s = '0'+s;}
      mTime = mTime +s;
      s = d.getHours().toString(2);
      while(s.length < 5) { s = '0'+s;}
      mTime = mTime +s;
      s = d.getMinutes().toString(2);
      while(s.length < 6) { s = '0'+s;}
      mTime = mTime +s;
      s = d.getSeconds().toString(2);
      while(s.length < 6) { s = '0'+s;}
      mTime = mTime +s;
      return parseInt(mTime, 2);
    }

    private onGotTimestamp(status: number, response: string){
      var This = this;
      if (status !== 200) {
        if(This.LoginCallback instanceof Function) {
            This.LoginCallback(false, status, response);
        }
      } else {
        var timestamp: number = parseInt(response, 10);
        This.ServerTimeStampOffset = timestamp - This.nowAsMormotTime();
        This.httpRequest(This.ServerURL + "/" + This.Root + "/Auth?UserName=" + This.User, This.GET_HTTP_VERB, null, This.onGotNonce)
      }
    }

    private clearSession() {
      var This = this;
      This.ServerURL = '';
      This.Root = '';
      This.User = '';
      This.SessionID = 0;
      This.SessionIDHexa8 = "";
      This.SessionPrivateKey = 0;
      This.LoginCallback = null;
      This.LogoutCallback = null;
      This.loggedIn = false;
      This.groupID = 0;
    }

    private onLogout(status: number, response: string) {
      var This = this, success: boolean = (status >= 200 && status < 300);
      This.loggedIn = false;
      if (This.LogoutCallback instanceof Function) {
        This.LogoutCallback(success, status, response);
      }
      This.clearSession();
    }

    public logIn(server: string, root: string, username: string, password: string, callback?: logInOutCallback, hashedPassword?:boolean, passedOptions?: Object): string {
      var This = this, d = new Date();   
      This.ServerURL = server;
      This.Root = root;
      This.User = username;
      This.LoginPassedOptions = passedOptions;
      if (hashedPassword) {
        This.PasswordHashHexa = password;
      } else {
        This.PasswordHashHexa = This.Sha256hash("salt" + password);
      }
      This.SessionTickCountOffset = d.getTime();
      if (callback) { This.LoginCallback = callback; }
      This.httpRequest(This.ServerURL + "/" + This.Root + "/TimeStamp", This.GET_HTTP_VERB, null, This.onGotTimestamp);
      return This.PasswordHashHexa;
    }

    public signUrl(url: string): string {
      var Tix, Nonce, s, ss, This = this, d = new Date();
      if (This.loggedIn === true) {
        Tix = d.getTime() - This.SessionTickCountOffset;
        Nonce = Tix.toString(16);
        while(Nonce.length < 8) { Nonce = '0'+Nonce; }
        if (Nonce.length > 8) { Nonce = Nonce.slice(Nonce.length-8); }
        ss = This.crc32(url, This.crc32(Nonce, This.SessionPrivateKey)).toString(16);
        while(ss.length < 8) { ss = '0'+ss; }
        s = url.indexOf("?") === -1 ? url+'?session_signature=' : url+'&session_signature=';
        return s + This.SessionIDHexa8 + Nonce + ss;
      } else {
        return url;
      }
    }

    public logout(callbackFunc?: logInOutCallback): void {
      var This = this;
      if (This.loggedIn === true) {
        if (callbackFunc) { This.LogoutCallback = callbackFunc; };
        This.httpRequest(This.ServerURL + "/" + This.signUrl(This.Root + "/Auth?UserName=" +
          This.User + "&Session=" + This.SessionID), This.GET_HTTP_VERB, null, This.onLogout);
      }
    }

    public logoutSync(): boolean {
      var This = this,
      status: number = This.loggedIn ? This.httpRequest(This.ServerURL + "/" + This.signUrl(This.Root + "/Auth?UserName=" + This.User + "&Session=" + This.SessionID), This.GET_HTTP_VERB, null, null, false):400,
      success: boolean = (status >= 200 && status < 300);
      if (success) { This.clearSession(); } 
      return success;
    }

    public retrieveRecordWhere(table:string, select: string, where: string, callback: retrieveRecordCallback) {
      var This = this;
      This.httpRequest(This.ServerURL + '/' + This.signUrl(This.Root + '/' + table + '?select=' + select + '&where=' + where ), This.GET_HTTP_VERB, null,
        function(HTTPstatus: number, response: string ){
          var obj = JSON.parse(response) || {};
          callback(HTTPstatus, obj);
        }
      );
    }

    public getTimestamp():number {
      return this.nowAsMormotTime() + this.ServerTimeStampOffset;
    }

    public retrieveRecord(table:string, id:number, forUpdate:boolean, callback: retrieveRecordCallback) {
      var This = this;
      This.httpRequest(This.ServerURL + '/' + This.signUrl(This.Root + '/' + table + "/" + id), forUpdate? This.GET_HTTP_VERB:This.LOCK_HTTP_VERB, null,
        function(HTTPstatus: number, response: string ){
          var obj = JSON.parse(response) || {};
          callback(HTTPstatus, obj);
        }
      );
    }

    public addRecord(table:string, record:{}, callback: addRecordCallback) {
      var This = this, pos, recordID;
      This.httpRequest(This.ServerURL + '/' + This.signUrl(This.Root + '/' + table), This.POST_HTTP_VERB, JSON.stringify(record || {}),
        function(HTTPstatus: number, response: string ){
          pos = response.lastIndexOf('/');
          recordID = parseInt(response.substr(pos+1), 10);
          callback(HTTPstatus, table, recordID);
        }
      );
    }

    public updateRecord(table:string, record: mORMotObject, callback: serverResposeCallback) {
      var This = this;
      if (!record.ID) {
        callback(400,'{"ErrorCode":400,"ErrorText":"Bad Request"}');
      } else {
        This.httpRequest(This.ServerURL + '/' + This.signUrl(This.Root + '/' + table + '/' + record.ID), This.PUT_HTTP_VERB,
          JSON.stringify(record || {}), callback);
      }
    }

    public get(url:string, callback?: serverResposeCallback, passedOptions?: Object ) {
      var This = this, obj;
      This.httpRequest(This.ServerURL + '/' + This.signUrl(This.Root + '/' +url), This.GET_HTTP_VERB, null, function(HTTPstatus: number, response: string){
        if ((HTTPstatus === 403) && (This.RetryLogin)){
          This.RetryLogin = false; //retry only once
          This.logIn(This.ServerURL, This.Root, This.User, This.PasswordHashHexa, function(success: boolean, HTTPstatus: number, response: string) {
            if (success) {
              This.httpRequest(This.ServerURL + '/' + This.signUrl(This.Root + '/' +url), This.GET_HTTP_VERB, null, function(HTTPstatus: number, response: string){
                if (callback instanceof Function) {
                  callback(HTTPstatus, response, This.LoginPassedOptions);
                }
              });
            }
          }, true, passedOptions);
        } else {
          if (callback instanceof Function) {
            callback(HTTPstatus, response, passedOptions);
          }
        }
      });
    }

    public post(url:string, postedData:any, callback?:serverResposeCallback, passedOptions?:Object) {
      var This = this;
      This.httpRequest(This.ServerURL + '/' + This.signUrl(This.Root + '/' +url), This.POST_HTTP_VERB, postedData, function(HTTPstatus: number, response: string){
        if ((HTTPstatus === 403) && (This.RetryLogin)){
          This.RetryLogin = false; //retry only once
          This.logIn(This.ServerURL, This.Root, This.User, This.PasswordHashHexa, function(success: boolean, HTTPstatus: number, response: string) {
            if (success) {
              This.httpRequest(This.ServerURL + '/' + This.signUrl(This.Root + '/' +url), This.POST_HTTP_VERB, postedData, function(HTTPstatus: number, response: string){
                if (callback instanceof Function) {
                  callback(HTTPstatus, response, This.LoginPassedOptions);
                }
              });
            }
          }, true, passedOptions);
        } else {
          if (callback instanceof Function) {
            callback(HTTPstatus, response, passedOptions);
          }
        }
      });
    }
  }
}
