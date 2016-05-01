'use strict';

var path = require('path');
var fs = require('fs');
var utf8 = require('utf8');
var Module = require('module');
var SassUnpackModule = require('sass-unpack');
var through2 = require('through2');
var ES = require('event-stream');
var File = require('vinyl');

var sourceMap = require('source-map');
var convertSourceMap = require('convert-source-map');

var sassUnpack;

function SassDevTools(options) {
	this.src = path.resolve(options.src);
	this.cmd = options.cmd;
	this.stream = null;
}

SassDevTools.prototype.init = function(devtoolsLive) {

	this.output = devtoolsLive.options.devtools.destination;
	sassUnpack = new SassUnpackModule({
		file: this.src,
		output: devtoolsLive.options.devtools.destination,
		directory: devtoolsLive.options.devtools.directory,
		map: true,
		sourcemap:true,
		mkdir: process.fs.mkdirpSync.bind(process.fs),
		write: process.fs.writeFileSync.bind(process.fs)
	});
	this.devtoolsLive = devtoolsLive;

	var sassMap = sassUnpack.unpack();
	return this.loadMap(sassMap);
};

SassDevTools.prototype.loadMap = function(sassMap) {
	process.live['sass'] = "";
	var map = sassMap.map;
	this.devtoolsLive.sassLinks = sassMap.links;
	var today = new Date().getTime();
	this.tasks = 0;
	for (var i in map) {
		map[i].plugin = this;
		map[i].output = this.output + '/' + map[i].url;

		this.devtoolsLive.registerFile(map[i]);

		var  sassDevToolsTmpFile = new SassDevToolsFile(this.devtoolsLive, map[i], this);
		this.cmd(
			sassDevToolsTmpFile.createFileStream(),
			sassDevToolsTmpFile.createWriteStream(),
			this.devtoolsLive.onError
		);

		process.live['sass'] += "\n<link rel='stylesheet' href='/" + map[i].url + "?" + today + "' />";
	}

	if(map.length == 0){
		this.devtoolsLive.streamFinished(this);
	}

};

SassDevTools.prototype.resolve = function(devtoolsLive, file) {
	for (var i in devtoolsLive.sassLinks[file.path]) {
		var filepath = devtoolsLive.sassLinks[file.path][i];
		var fileTmp =  devtoolsLive.tmp[filepath];

		var  sassDevToolsTmpFile = new SassDevToolsFile(devtoolsLive, fileTmp, this);
		this.cmd(
			sassDevToolsTmpFile.createFileStream(),
			sassDevToolsTmpFile.createWriteAndPushStream(),
			devtoolsLive.onError
		);
	}


};

function SassDevToolsFile(devtoolsLive, file, sassDevTools) {
	this.file = file;
	this.devtoolsLive = devtoolsLive;
	this.sassDevTools = sassDevTools;
}

SassDevToolsFile.prototype.cleanSourceMap = function(sassContent, sourceContent) {

	var fileSourceMap = null;
	var generator = new sourceMap.SourceMapGenerator({
		file: '/' + this.file.url
	});

	var sourcemap = convertSourceMap.fromSource(sassContent, true);

	sourcemap = sourcemap.toObject();

	var consumer = new sourceMap.SourceMapConsumer(sourcemap);

	consumer.eachMapping(function(m) {

 		var path = m.source.replace(sourcemap.sourceRoot, '');
		var filepath =  Module._findPath(path, [sassUnpack.rootDir, sassUnpack.sourceDir]).replace(sassUnpack.sourceDir, '');
		generator.addMapping({
						  source: '/'+filepath,
						  original: { line: m.originalLine, column: m.originalColumn },
						  generated: { line: m.generatedLine , column: m.generatedColumn }
						});

	}.bind(this), {}, consumer.ORIGINAL_ORDER);

	for(var i in sourcemap.sources){

 		var path = sourcemap.sources[i].replace(sourcemap.sourceRoot, '').replace(sassUnpack.rootDir, '');
 		path = Module._findPath(path, [sassUnpack.rootDir, sassUnpack.sourceDir]);
 		var filepath =  path.replace(sassUnpack.sourceDir, '');

 		sourcemap.sources[i]=filepath;
	}

	sourcemap.mappings = generator.toJSON().mappings;
	sourcemap.file = '/' + this.file.url;

	sourcemap.sourceRoot = '/';

	return convertSourceMap.fromObject(sourcemap).toComment({multiline:true});

};

SassDevToolsFile.prototype.saveFile = function(filepath, sassContent) {
	var inline = this.cleanSourceMap(sassContent);
	var content = convertSourceMap.removeComments(sassContent);
	process.fs.writeFileSync(filepath, content+'\n'+ inline);

	if(this.sassDevTools.tasks > 0){
		this.sassDevTools.tasks--;
		if(this.sassDevTools.tasks == 0){
			this.devtoolsLive.streamFinished(this.sassDevTools);
		}
	}

	return content;
}

SassDevToolsFile.prototype.pushFile = function(sassContent) {
	var record = {
			action: 'update',
			url: this.devtoolsLive.getClientPageUrl() + this.file.url
		};

		if (this.file.content === undefined) {
			record.sync = this.devtoolsLive.getClientHostname() + '/' + this.file.src;
		} else {
			record.resourceName = this.devtoolsLive.getClientHostname() + '/' + this.file.src;
			delete this.file.content;
		}

		record.event = this.file.src;

		record.content = this.saveFile(this.file.output, sassContent);

		this.devtoolsLive.broadcast(record);


		if(this.sassDevTools.tasks > 0){
			this.sassDevTools.tasks--;
			if(this.sassDevTools.tasks == 0){
				this.devtoolsLive.streamFinished(this.sassDevTools);
			}
		}



};

SassDevToolsFile.prototype.createWriteAndPushStream = function() {
	 var modifyFile = function(file) {
	 	if (file.contents.length > 0) {
		this.pushFile(file.contents.toString());
	 	}else {
		this.pushFile('/** empty **/');
	 	}
  }.bind(this);

	return ES.through(modifyFile);

};

SassDevToolsFile.prototype.createWriteStream = function() {

	 var modifyFile = function(file) {
	 	if (file.contents.length > 0) {
		this.saveFile(this.file.output,  file.contents.toString());
	 	}else {
		this.saveFile(this.file.output, '/** empty **/');
	 	}
  }.bind(this);

	return ES.through(modifyFile);
};

SassDevToolsFile.prototype.createFileStream = function() {
	var data = process.fs.readFileSync(this.file.tmp);

	this.sassDevTools.tasks++;


	var file = new File({
		path: this.file.src,
		contents: ((data instanceof Buffer) ? data : new Buffer(data))
	});

	var stream = through2.obj(function(file, enc, callback) {
		this.push(file);
		return callback();
	});

	stream.write(file);

	return stream;

};

module.exports = SassDevTools;
