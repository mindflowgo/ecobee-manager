/*************************************************
 * Written 18 Jan, 2020 by Filipe Laborde
 * 
 * Open-source, MIT license - use as you wish.
 * 
 * Packages dependencies:
 * npm install --save tplink-cloud-api nodemailer axios uuid dotenv
 * 
 * Configure .env file with elements below in SETTINGS
 */

const result = require('dotenv').config();
if( result.error ){
  console.log( `ERROR: Missing .env, please create it!` ); //result.error
  process.exit(1);
}

const fs = require('fs');
const nodemailer = require('nodemailer');
const axios = require('axios').default;
const { login } = require("tplink-cloud-api");
const uuidV4 = require("uuid/v4");

/* SETTINGS (from .env file) ------ read sensor data and alert when it's out of scope */
const API_KEY       = process.env.API_KEY;
const SMTP_LOGIN    = process.env.SMTP_LOGIN;
const SMTP_PASS     = process.env.SMTP_PASS;
const SETTINGS_FILE = __dirname + process.env.SETTINGS_FILE;
const LOG_FILE      = __dirname + process.env.LOG_FILE;
const TPLINK_USER   = process.env.TPLINK_USER;
const TPLINK_PASS   = process.env.TPLINK_PASS;
const TPLINK_TERM   = uuidV4();

function logWrite( output ){
    fs.appendFileSync( LOG_FILE, output+"\n" );
    console.log( output );
}

function settingsSave( settings={} ){
    fs.writeFileSync( SETTINGS_FILE, JSON.stringify(settings) );
}

function mailSend( subject, text ){
    return new Promise( (resolve,reject) => {
        let transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
            user: SMTP_LOGIN,
            pass: SMTP_PASS
            }
        });

        // Message object
        let message = {
            // Comma separated list of recipients
            to: `Alerter <${SMTP_LOGIN}>`,
            subject, text
        };

        transporter.sendMail(message, (error, info) => {
            if (error) {
                console.log( 'Error occurred: '+ error.message );
                reject();
            }

            console.log('Message sent successfully!');
            transporter.close();
            resolve();
        });
    });
}

async function deviceToggle( name, powerMode ){
    // log in to cloud, return a connected tplink object
    const tplink = await login(TPLINK_USER, TPLINK_PASS, TPLINK_TERM);
    
    // get a list of raw json objects (must be invoked before .get* works)
    const dl = await tplink.getDeviceList();
    
    const device = tplink.getHS110(name); 
    const response = await (powerMode=='powerOn' ? device.powerOn() : device.powerOff() );
    
    return response.system.set_relay_state.err_code == 0;
}

( async ()=>{
    console.log( `-- starting --` );

    let settings = {};
    try { 
        settings = JSON.parse( fs.readFileSync( SETTINGS_FILE ) );
    } catch( e ){
        console.log( `~ error reading settings, creating new file.` );
        settingsSave();
    }

    // -- ADDING APP (with PIN method) ----------------------
    if( !settings.authCode ){
        // now we generate 4-digit PIN that the user must use to Add to 'MyApps' with permissions
        const response = await axios.get(`https://api.ecobee.com/authorize?response_type=ecobeePin&client_id=${API_KEY}&scope=smartRead`)

        const pin = response.data.ecobeePin;
        settings.authCode = response.data.code;

        console.log( `
        ** User Action Required **
        Go to 'My Apps' > 'Add Application' and enter this PIN (and add the app): ${pin}      
        `);

        settingsSave(settings);
        const mailResponse = await mailSend( '!App Auth Required', 'You need to relogin to the Ecobee app' );

        // exit, let user add the app
        process.exit(1);
    }

    // -----------------------------------------------------
    // now we're asking for an auth token (that will be valid one) - we use the PIN authCode that is valid one year

    // POST request for the token
    if( !settings.access_token ){
        console.log( `~ updating access_token` );
        // attempt to use refresh_token (as the actual token expires after 1 hour)
        const response = await axios.post( `https://api.ecobee.com/token`,
                `client_id=${API_KEY}&` +( settings.refresh_token ? 
                    `grant_type=refresh_token&code=${settings.refresh_token}` :
                    `grant_type=ecobeePin&code=${settings.authCode}` ) );
                
        if( response.data.error ){
            logWrite( "ERROR: {$jsonResult['error_description']}\n" );

            if( response.data.error=='authorization_expired' )
                delete( settings.authCode );
            else
                delete( settings.access_token );

            settingsSave(settings);  
            // exit, and lets try login next time this app- runs              
            process.exit(1);
        }

        // update settings with latest token info
        settings = { ...settings, ...response.data };
        settingsSave( settings );
    }

    
// // read the sensors
    const url = 'https://api.ecobee.com/1/thermostat?json='+JSON.stringify(
        { selection:
            {   selectionType: "registered",
                selectionMatch: "",
                includeSensors: "true",
                includeRuntime: "true" } });
    // console.log( `.. about to get url: header Auth(${settings.token_type} ${settings.access_token}): `, url );   
    let response;
    try {
        response = await axios.get( url, {
                headers: {
                "Content-Type": "text/json",
                Authorization: `${settings.token_type} ${settings.access_token}`
                }
            });

    } catch( error ){
        // Error 500 happens when auth expired
        // But the actual response is still passed back (axios puts in error.response), so we 
        // use that and proceed accordingly.
        console.log( `x loading url(${url}) failed: `+error.message );
        response = error.response;
    }

    const statusCode = response.data.status.code;
    if( statusCode !== 0 ){
        logWrite( `\t! API-Error: ${response.data.status.message} `
            + (statusCode == 14 ? `; cleared access_token for retry...` : '' ) );

        if( statusCode == 14 ){
            // expired auth token, clearing so we get another
            delete( settings.access_token );
            settingsSave( settings );
        }
        // exit as auth error, cleared token will try again next time
        process.exit(1);
    }

// // good
logWrite( "\n" + new Date().toLocaleString() );

response.data.thermostatList.forEach( thermostat => {
    if( !thermostat.runtime.connected ){
        logWrite( "\t! Error: Thermostat NOT connected: ${thermostat.name}\n" );
        return;
    }

    const runTime = thermostat.runtime;
    const temp = ((Number(runTime.actualTemperature) - 320) * 5/90).toFixed(1);
    const humidity = runTime.actualHumidity;
    logWrite( `\t${thermostat.name}: Overall temp: ${temp}℃, ${humidity}%` );
        
    thermostat.remoteSensors.forEach( async remoteSensor => {
        let temp = 0; let occupancy = false;
        remoteSensor.capability.forEach( capability => {
            if( capability.type=='temperature' )
                temp = ( (Number(capability.value)-320) * 5/90 ).toFixed(1);
            else if( capability.type=='occupancy' )
                occupancy = capability.value=="true";
        })
        logWrite(`\t\t - ${remoteSensor.name}: ${temp}℃` + ( occupancy ? '[*]' : '' ) );

        // custom handling, expand depending on needs
        if( remoteSensor.name=='Sunroom' ){
            if( temp>12 && settings.device_SunroomHeater !== 'powerOff' ){
                const powerMode = 'powerOff';
                const result = await deviceToggle( 'SunroomHeater', powerMode );
                if( result ){
                    settings.device_SunroomHeater = powerMode;
                    logWrite( `\t[deviceAction] SunroomHeater turning OFF (temp=${temp})` );
                } else {
                    logWrite( `\t[deviceAction] !Error: SunroomHeater *FAILED* turning off (temp=${temp}) ` );
                }

            } else if( temp<11 && settings.device_SunroomHeater !== 'powerOn' ){
                const powerMode = 'powerOn';
                const result = await deviceToggle( 'SunroomHeater', powerMode );
                if( result ){
                    settings.device_SunroomHeater = powerMode;
                    logWrite( `\t[deviceAction] SunroomHeater turning ON (temp=${temp})` );
                } else {
                    logWrite( `\t[deviceAction] !Error: SunroomHeater *FAILED* turning on (temp=${temp}) ` );
                }
            }
            settingsSave(settings);

            if( temp<5 ){
                const mailResponse = await mailSend( `!Sunroom Temperature ${temp} degrees`, `Sunroom temperature ${temp} degrees: action required` );
                logWrite( "\t\t * SUNROOM problem, sending email!\n" );
            }
        }
        
    })
})

})();