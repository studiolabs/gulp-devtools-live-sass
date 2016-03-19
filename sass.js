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
	this.loadMap(sassMap);
};

SassDevTools.prototype.loadMap = function(sassMap) {
	process.live['sass'] = "";
	var map = sassMap.map;
	this.devtoolsLive.sassLinks = sassMap.links;
	var today = new Date().getTime();
	for (var i in map) {
		map[i].plugin = this;
		map[i].output = this.output + '/' + map[i].url;

		this.devtoolsLive.registerFile(map[i]);

		var  sassDevToolsTmpFile = new SassDevToolsFile(this.devtoolsLive, map[i]);
		this.cmd(
			sassDevToolsTmpFile.createFileStream(map[i]),
			sassDevToolsTmpFile.createWriteStream(),
			this.devtoolsLive.onError
		);

		process.live['sass'] += "\n<link rel='stylesheet' href='/" + map[i].url + "?" + today + "' />";
	}

};

SassDevTools.prototype.resolve = function(devtoolsLive, file) {
	for (var i in devtoolsLive.sassLinks[file.path]) {
		var filepath = devtoolsLive.sassLinks[file.path][i];
		var fileTmp =  devtoolsLive.dev[filepath];

		var  sassDevToolsTmpFile = new SassDevToolsFile(devtoolsLive, fileTmp);
		this.cmd(
			sassDevToolsTmpFile.createFileStream(fileTmp),
			sassDevToolsTmpFile.createWriteAndPushStream(),
			devtoolsLive.onError
		);
	}

};

function SassDevToolsFile(devtoolsLive, file) {
	this.file = file;
	this.devtoolsLive = devtoolsLive;
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
						  source: '/'+path,
						  original: { line: m.originalLine, column: m.originalColumn },
						  generated: { line: m.generatedLine , column: m.generatedColumn }
						});

	}.bind(this), {}, consumer.ORIGINAL_ORDER);

	for(var i in sourcemap.sources){
 		var path = sassUnpack.rootDir + sourcemap.sources[i].replace(sourcemap.sourceRoot, '');
 		var filepath =  Module._findPath(path, [sassUnpack.rootDir, sassUnpack.sourceDir]).replace(sassUnpack.sourceDir, '');
 		sourcemap.sources[i]=filepath;
	}

	sourcemap.mappings = generator.toJSON().mappings;
	sourcemap.file = '/' + this.file.url;

	sourcemap.sourceRoot = '/';

	var inline = convertSourceMap.fromObject(sourcemap).toComment({multiline:true});

	console.log(convertSourceMap.fromComment(inline).toObject());

	return convertSourceMap.removeComments(sassContent) +'\n'+ inline;
};

SassDevToolsFile.prototype.saveFile = function(filepath, sassContent) {
	var content = this.cleanSourceMap(sassContent);
	process.fs.writeFileSync(filepath, content);

	return content;
}

SassDevToolsFile.prototype.pushFile = function(sassContent) {
	var record = {
			action: 'update',
			resourceURL: this.devtoolsLive.getClientPageUrl() + this.file.url
		};

	var originalFileContent = '';
	if (this.file.content === undefined) {
		originalFileContent = utf8.encode(fs.readFileSync(this.file.path).toString());
		record.sync = this.devtoolsLive.getClientHostname() + '/' + this.file.name;
	} else {
		originalFileContent = this.file.content;
		delete this.file.content;
		record.resourceName = this.devtoolsLive.getClientHostname() + '/' + this.file.name;
	}

	record.event = this.file.variable;

	this.file.sync = originalFileContent;

	record.content = this.saveFile(this.file.output, sassContent, originalFileContent);

	this.devtoolsLive.broadcast(record);

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
	var data = process.fs.readFileSync(this.file.dev);

	var file = new File({
		path: this.file.path,
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
