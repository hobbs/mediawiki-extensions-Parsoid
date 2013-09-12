"use strict";

var Util = require( './mediawiki.Util.js' ).Util,
	coreutil = require('util'),
	ExtensionHandler = require('./ext.core.ExtensionHandler.js').ExtensionHandler,
	defines = require('./mediawiki.parser.defines.js'),
	KV = defines.KV,
	SelfclosingTagTk = defines.SelfclosingTagTk,
	TagTk = defines.TagTk,
	EndTagTk = defines.EndTagTk,
	async = require('async');

var Gallery = function() {
};

// Inherit functionality from ExtensionHandler
coreutil.inherits(Gallery, ExtensionHandler);

Gallery.prototype.handleGallery = function(manager, pipelineOpts, galleryToken, cb) {
	var lines = this._getLines(galleryToken);
	this.manager = manager;
	this._processLines(lines, this._processLinesHandler.bind( this, galleryToken, cb ));
	cb({ 'async': true });

};

Gallery.prototype._getLines = function(galleryToken) {
	var outerSrc = galleryToken.getAttribute('source'),
		tagWidths = galleryToken.dataAttribs.tagWidths,
		innerSrc = outerSrc.substring(tagWidths[0], outerSrc.length - tagWidths[1]);
	return innerSrc.split('\n');
};

Gallery.prototype._processLines = function(lines, callback) {
	async.map(lines, this._processLine.bind(this), callback);
};

Gallery.prototype._processLinesHandler = function(galleryToken, cb, err, results) {
	var da = Util.clone(galleryToken.dataAttribs),
		galleryOpts = Util.KVtoHash(galleryToken.getAttribute('options')),
		dataMw = { 'name': 'gallery', 'attrs': galleryOpts },
		tokens = [],
		i;
	da.stx = undefined;
	tokens.push(new defines.TagTk('div', [
		new KV('typeof', 'mw:Extension/Gallery'),
		new KV('data-mw', JSON.stringify(dataMw))
	], da));
	for(i = 0; i < results.length; i++) {
		tokens = tokens.concat(results[i]);
	}
	tokens.push(new defines.EndTagTk('div'));
	cb({ 'tokens': tokens, 'async': false });
};

Gallery.prototype._processLine = function(line, callback) {
	var hasNamespace, wt;
	if(line.trim() === '') {
		// Usually first and last lines are empty
		callback(null, this._createPlaceholder(line));
	} else {
		hasNamespace = !!line.match(/^[^|]*:/)
		wt = line;
		if(!hasNamespace) {
			wt = 'Image:' + wt;
		}
		wt = '[[' + wt + '|thumb|none]]'
		this._processInPipeline(
			wt,
			this._processInPipelineHandler.bind(this, line, hasNamespace, callback)
		);
	}
};

// TODO: Should be defined as a static?
Gallery.prototype._createPlaceholder = function(src){
	return [
		new SelfclosingTagTk('meta', [new KV('typeof', 'mw:Placeholder')], { 'src': src })
	];
};

// TODO: Should be defined as a static?
Gallery.prototype._createDOMFragment = function(src){
	return [
		new TagTk( 'div', [ { 'k': 'typeof', 'v': 'mw:DOMFragment' } ], { 'html': src } ),
		new EndTagTk( 'div' )
	];
};

Gallery.prototype._processInPipeline = function(src, callback) {
	var pipeline = this.manager.pipeFactory.getPipeline(
		'text/x-mediawiki/full', { isInclude: true, wrapTemplates: false, inBlockToken: true }
	);
	pipeline.addListener('document', callback);
	pipeline.process(src);
};

Gallery.prototype._processInPipelineHandler = function(line, hasNamespace, callback, doc) {
	var dataParsoid;
	if(doc.body.childNodes.length !== 1 || doc.body.firstChild.getAttribute('typeof') !== 'mw:Image/Thumb') {
		callback(null, this._createPlaceholder(line));
	} else {
		dataParsoid = JSON.parse(doc.body.firstChild.getAttribute('data-parsoid'));
		dataParsoid.hasNamespace = hasNamespace;
		doc.body.firstChild.setAttribute('data-parsoid', JSON.stringify(dataParsoid));
		callback(null, this._createDOMFragment(doc.body.innerHTML));
	}
};

if (typeof module === "object") {
	module.exports.Gallery = Gallery;
}