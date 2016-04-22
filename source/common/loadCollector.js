/*global require, setInterval, module*/
'use strict';

var logger = require('./logger').logger;

// Logger
var log = logger.getLogger('LoadCollector');

var child_process = require('child_process');

var cpuCollector = function (period, on_load) {
    var child = child_process.spawn('top', ['-b', '-d', Math.max(Math.floor(period / 1000), 1)]);

    child.stdout.on('data', function (data) {
        var cpuline = data.toString().split('\n').filter(function (line) {return line.startsWith('%Cpu(s):');})[0];
        var regex = /\s+(\d+\.\d+)\s+id/;

        if (cpuline) {
            var m = regex.exec(cpuline);
            if (m && (m.length === 2)) {
                on_load(Math.floor(100 - Number(m[1])) / 100);
            }
        }
    });

    child.stderr.on('data', function (error) {
        log.error('cpu collector error:', error.toString());
    });

    this.stop = function () {
        log.debug("To stop cpu load collector.");
        child && child.kill();
        child = undefined;
    };
}

var diskCollector = function (period, drive, on_load) {
    var interval = setInterval(function () {
        var total = 1, free = 0;
        child_process.exec("df -k '" + drive.replace(/'/g,"'\\''") + "'", function(err, stdout, stderr) {
            if (err) {
                log.error(stderr);
            } else {
                var lines = stdout.trim().split('\n');

                var str_disk_info = lines[lines.length - 1].replace( /[\s\n\r]+/g,' ');
                var disk_info = str_disk_info.split(' ');

                total = disk_info[1];
                free = disk_info[3];
                on_load(1.0 - free / total);
            }
        });
    }, period);

    this.stop = function () {
        log.debug("To stop disk load collector.");
        clearInterval(interval);
    }
};

var networkCollector = function (period, interf, max_scale, on_load) {
    var child = child_process.spawn('nload', ['-u', 'm', '-t', period + '', 'devices', interf + '']);

    child.stdout.on('data', function (data) {
        var concernedLine = new RegExp('(Avg:)'),
            val = new RegExp('^.*Avg:\\s+(.*)\\s+MBit\\/s');
        var lines = data.toString().split('\u001b').filter(function (line) {return concernedLine.test(line);});
        if (lines.length === 2) {
            var receiveSpeed = Number(lines[0].match(val)[1]),
                sendSpeed = Number(lines[1].match(val)[1]);
            on_load(Math.max(receiveSpeed / max_scale, sendSpeed / max_scale));
        } else {
            log.warn('Not ordinary nload data');
        }
    });

    this.stop = function () {
        log.debug("To stop network load collector.");
        child && child.kill();
        child = undefined;
    };
};

var gpuCollector = function (period, on_load) {
    var child = child_process.spawn('intel_gpu_top', ['-s', '200']);
    var cpu_load = 0,
        cpu_collector = new cpuCollector(period, function (data) {cpu_load = data;});

    var renders = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], render_sum = 0,
        bitstreams = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bitstream_sum = 0,
        blitters = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], blitter_sum = 0,
        load = 0;
    child.stdout.on('data', function (data) {
       var lines = data.toString().split('\n');

       lines.forEach(function (line) {
           var m = null;
           if ((m = line.match(/\s+render busy:\s+(\d+)%/)) && m !== null && m.length > 1) {
               var render = Number(m[1]),
                   old = renders.shift();
               renders.push(render);
               render_sum = render_sum - old + render;
           } else if ((m = line.match(/\s+bitstream busy:\s+(\d+)%/)) && m !== null && m.length > 1) {
               var bitstream = Number(m[1]),
                   old = bitstreams.shift();
               bitstreams.push(bitstream);
               bitstream_sum = bitstream_sum - old + bitstream;
           } else if ((m = line.match(/\s+blitter busy:\s+(\d+)%/)) && m !== null && m.length > 1) {
               var blitter = Number(m[1]),
                   old = blitters.shift();
               blitters.push(blitter);
               blitter_sum = blitter_sum - old + blitter;
               load = (Math.floor(Math.max(render_sum, bitstream_sum, blitter_sum) / 10)) / 100;
           }
       });
    });

    var interval = setInterval(function () {
        var result = Math.max(load, cpu_load);
        on_load(result);
    }, period);

    this.stop = function () {
        log.debug("To stop gpu load collector.");
        cpu_collector && cpu_collector.stop();
        cpu_collector = undefined;
        child && child.kill();
        child = undefined;
        interval && clearInterval(interval);
        interval = undefined;
    };
};

exports.LoadCollector = function (spec) {
    var that = {};

    var period = spec.pediod || 1000,
        item = spec.item,
        on_load = spec.onLoad || function (load) {log.debug('Got', item.name, 'load:', load);},
        collector = undefined;

    that.stop = function () {
        log.info("To stop load collector.");
        collector && collector.stop();
        collector = undefined;
    };

    switch (item.name) {
        case 'network':
            collector = new networkCollector(period, item.interface, item.max_scale, on_load);
            break;
        case 'cpu':
            collector = new cpuCollector(period, on_load);
            break;
        case 'gpu':
            collector = new gpuCollector(period, on_load);
            break;
        case 'memory':
            log.error('Not support memory load currently.');
            return undefined;
            //break;
        case 'disk':
            collector = new diskCollector(period, item.drive, on_load);
            break;
        default:
            log.error('Unknown load item');
            return undefined;
            //break;
    }

    return that;
};