var fs = require('fs');
var winston = require('winston');
var my = require('./my');
var parse = require('./parse');

var debug = process.env.DEBUG ? true : false;

var gpioFile = {};
var pwmPrefix = {};
var ainPrefix = "";

exports.logfile = '/var/lib/cloud9/bonescript.log';

exports.readPWMFreqAndValue = function(pin, pwm) {
    var mode = {};
    try {
        var period = fs.readFileSync(pwmPrefix[pin.pwm.name]+'/period_ns');
        var duty = fs.readFileSync(pwmPrefix[pin.pwm.name]+'/duty_ns');
        mode.freq = 1.0e9 / period;
        mode.value = duty / period;
    } catch(ex) {
    }
    return(mode);
};

exports.readGPIODirection = function(n, gpio) {
    var mode = {};
    var directionFile = "/sys/class/gpio/gpio" + n + "/direction";
    if(my.file_existsSync(directionFile)) {
        mode.active = true;
        var direction = fs.readFileSync(directionFile, 'utf-8');
        direction = direction.replace(/^\s+|\s+$/g, '');
        mode.direction = direction;
    }
    return(mode);
};

exports.readPinMux = function(pin, mode, callback) {
    var pinctrlFile = '/sys/kernel/debug/pinctrl/44e10800.pinmux/pins';
    var muxRegOffset = parseInt(pin.muxRegOffset, 16);
    var readPinctrl = function(err, data) {
        if(err) {
            mode.err = 'readPinctrl error: ' + err;
            if(debug) winston.debug(mode.err);
            callback(mode);
        }
        mode = parse.modeFromPinctrl(data, muxRegOffset, 0x44e10800, mode);
        callback(mode);
    };
    var tryPinctrl = function(exists) {
        if(exists) {
            fs.readFile(pinctrlFile, 'utf8', readPinctrl);
        } else {
            if(debug) winston.debug('getPinMode(' + pin.key + '): no valid mux data');
            callback(mode);
        }
    };
    my.file_exists(pinctrlFile, tryPinctrl);
};

exports.setPinMode = function(pin, pinData, template, resp, callback) {
    if(debug) winston.debug('hw.setPinMode(' + [pin.key, pinData, template, JSON.stringify(resp)] + ');');
    var p = pin.key + "_pinmux"
    var pinmux = my.find_sysfsFile(p, my.is_ocp(), p + '.');
    if((pinData & 7) == 7) {
        gpioFile[pin.key] = '/sys/class/gpio/gpio' + pin.gpio + '/value';
        fs.writeFileSync(pinmux+"/state", 'gpio');
    } else if(template == 'bspwm') {
        fs.writeFileSync(pinmux+"/state", 'pwm');
        pwmPrefix[pin.pwm.name] = '/sys/class/pwm/pwm' + pin.pwm.sysfs;
        if(!my.file_existsSync(pwmPrefix[pin.pwm.name])) {
            fs.appendFileSync('/sys/class/pwm/export', pin.pwm.sysfs);
        }
        fs.appendFileSync(pwmPrefix[pin.pwm.name]+'/run', 1);
    } else {
        resp.err = 'Unknown pin mode template';
    }
    if(callback) callback(resp);
    return(resp);
};

exports.setLEDPinToGPIO = function(pin, resp) {
    var path = "/sys/class/leds/beaglebone:green:" + pin.led + "/trigger";

    if(my.file_existsSync(path)) {
        fs.writeFileSync(path, "gpio");
    } else {
        resp.err = "Unable to find LED " + pin.led;
        winston.error(resp.err);
        resp.value = false;
    }

    return(resp);
};

exports.exportGPIOControls = function(pin, direction, resp, callback) {
    if(debug) winston.debug('hw.exportGPIOControls(' + [pin.key, direction, resp] + ');');
    var n = pin.gpio;
    var exists = my.file_existsSync(gpioFile[pin.key]);
    
    if(!exists) {
        if(debug) winston.debug("exporting gpio: " + n);
        fs.writeFileSunc("/sys/class/gpio/export", "" + n, null);
    }
    var directionFile = "/sys/class/gpio/gpio" + n + "/direction";
    if(debug) winston.debug('Writing GPIO direction(' + direction + ') to ' + 
        directionFile + ');');
    fs.writeFileSync(directionFile, direction);
    return(resp);
};

exports.writeGPIOValue = function(pin, value, callback) {
    if(typeof gpioFile[pin.key] == 'undefined') {
        gpioFile[pin.key] = '/sys/class/gpio/gpio' + pin.gpio + '/value';
        if(pin.led) {
            gpioFile[pin.key] = "/sys/class/leds/beaglebone:";
            gpioFile[pin.key] += "green:" + pin.led + "/brightness";
        }
        if(!my.file_existsSync(gpioFile[pin.key])) {
            winston.error("Unable to find gpio: " + gpioFile[pin.key]);
        }
    }
    if(debug) winston.debug("gpioFile = " + gpioFile[pin.key]);
    fs.writeFileSync(gpioFile[pin.key], '' + value);
    if(callback) callback();
};

exports.readGPIOValue = function(pin, resp, callback) {
    var gpioFile = '/sys/class/gpio/gpio' + pin.gpio + '/value';
    var readFile = function(err, data) {
        if(err) {
            resp.err = 'digitalRead error: ' + err;
            winston.error(resp.err);
        }
        resp.value = parseInt(data, 2);
        callback(resp);
    };
    fs.readFile(gpioFile, readFile);
};

exports.enableAIN = function(callback) {
    var resp = {};
    var ocp = my.is_ocp();
    if(!ocp) {
        resp.err = 'enableAIN: Unable to open ocp file';
        if(debug) winston.debug(resp.err);
        callback(resp);
        return;
    }
    
    my.load_dt('cape-bone-iio', null, {}, onLoadDT);
    
    function onLoadDT(x) {
        if(x.err) {
            callback(x);
            return;
        }
        my.find_sysfsFile('helper', ocp, 'helper.', onHelper);
    }

    function onHelper(x) {
        if(x.err || !x.path) {
            resp.err = 'Error enabling analog inputs: ' + x.err;
            if(debug) winston.debug(resp.err);
        } else {
            ainPrefix = x.path + '/AIN';
            if(debug) winston.debug("Setting ainPrefix to " + ainPrefix);
        }
        callback(x);
    }
};

exports.readAIN = function(pin, resp, callback) {
    var ainFile = ainPrefix + pin.ain.toString();
    fs.readFile(ainFile, readFile);
    
    function readFile(err, data) {
        if(err) {
            resp.err = 'analogRead error: ' + err;
            winston.error(resp.err);
        }
        resp.value = parseInt(data, 10) / 1800;
        callback(resp);
    }
};

exports.writeGPIOEdge = function(pin, mode) {
    fs.writeFileSync('/sys/class/gpio/gpio' + pin.gpio + '/edge', mode);

    var resp = {};
    resp.gpioFile = '/sys/class/gpio/gpio' + pin.gpio + '/value';
    resp.valuefd = fs.openSync(resp.gpioFile, 'r');
    resp.value = new Buffer(1);

    return(resp);
};

exports.writePWMFreqAndValue = function(pin, pwm, freq, value, resp, callback) {
    if(debug) winston.debug('hw.writePWMFreqAndValue(' + [pin.key,pwm,freq,value,resp] + ');');
    var path = pwmPrefix[pin.pwm.name];
    try {
        var period = Math.round( 1.0e9 / freq ); // period in ns
        if(pwm.freq != freq) {
            if(debug) winston.debug('Stopping PWM');
            fs.appendFileSync(path+'/run', "0\n");
            if(debug) winston.debug('Setting duty to 0');
            fs.appendFileSync(path+'/duty_ns', "0\n");
            try {
                if(debug) winston.debug('Updating PWM period: ' + period);
                fs.appendFileSync(path+'/period_ns', period + "\n");
            } catch(ex2) {
                period = fs.readFileSync(path+'/period_ns');
                winston.info('Unable to update PWM period, period is set to ' + period);
            }
            if(debug) winston.debug('Starting PWM');
            fs.appendFileSync(path+'/run', "1\n");
        }
        var duty = Math.round( period * value );
        if(debug) winston.debug('Updating PWM duty: ' + duty);
        //if(duty == 0) winston.error('Updating PWM duty: ' + duty);
        fs.appendFileSync(path+'/duty_ns', duty + "\n");
    } catch(ex) {
        resp.err = 'error updating PWM freq and value: ' + path + ', ' + ex;
        winston.error(resp.err);
    }
    return(resp);
};

exports.readEeproms = function(eeproms) {
    var boardName = fs.readFileSync(my.is_capemgr() + '/baseboard/board-name',
            'ascii');
    var version = fs.readFileSync(my.is_capemgr() + '/baseboard/revision',
            'ascii');
    var serialNumber = fs.readFileSync(my.is_capemgr() + '/baseboard/serial-number',
            'ascii');
    eeproms['/sys/bus/i2c/drivers/at24/1-0050/eeprom'] = {};
    eeproms['/sys/bus/i2c/drivers/at24/1-0050/eeprom'].boardName = boardName;
    eeproms['/sys/bus/i2c/drivers/at24/1-0050/eeprom'].version = version;
    eeproms['/sys/bus/i2c/drivers/at24/1-0050/eeprom'].serialNumber = serialNumber;
    return(eeproms);
};

exports.readPlatform = function(platform) {
    platform.name = fs.readFileSync(my.is_capemgr() + '/baseboard/board-name',
        'ascii').trim();
    if(platform.name == 'A335BONE') platform.name = 'BeagleBone';
    if(platform.name == 'A335BNLT') platform.name = 'BeagleBone Black';
    platform.version = fs.readFileSync(my.is_capemgr() + '/baseboard/revision',
        'ascii').trim();
    if(!platform.version.match(/^[\040-\176]*$/)) delete platform.version;
    platform.serialNumber = fs.readFileSync(my.is_capemgr() +
        '/baseboard/serial-number', 'ascii').trim();
    if(!platform.serialNumber.match(/^[\040-\176]*$/)) delete platform.serialNumber;
    try {
        platform.dogtag = fs.readFileSync('/etc/dogtag', 'ascii');
    } catch(ex) {
    }
    return(platform);
};
