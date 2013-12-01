/*
 * A very basic parser / serializer web service.
 *
 * Local configuration:
 *
 * To configure locally, add localsettings.js to this directory and export a setup function.
 *
 * example:
 *	exports.setup = function( config, env ) {
 *		env.setInterwiki( 'localhost', 'http://localhost/wiki' );
 *	};
 */

/**
 * @class ParserServiceModule
 * @singleton
 * @private
 */

// global includes
var express = require('express'),
	domino = require( 'domino' ),
	jsDiff = require('diff'),
	childProc = require('child_process'),
	spawn = childProc.spawn,
	cluster = require('cluster'),
	fs = require('fs'),
	path = require('path'),
	newrelic;

// local includes
var mp = '../lib/';

var lsp, localSettings;

try {
	lsp = __dirname + '/localsettings.js';
	localSettings = require( lsp );
} catch ( e ) {
	// Build a skeleton localSettings to prevent errors later.
	localSettings = {
		setup: function ( pconf ) {}
	};
}

/**
 * The name of this instance.
 * @property {string}
 */
var instanceName = cluster.isWorker ? 'worker(' + process.pid + ')' : 'master';

console.log( ' - ' + instanceName + ' loading...' );

var WikitextSerializer = require(mp + 'mediawiki.WikitextSerializer.js').WikitextSerializer,
	SelectiveSerializer = require( mp + 'mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	Util = require( mp + 'mediawiki.Util.js' ).Util,
	DU = require( mp + 'mediawiki.DOMUtils.js' ).DOMUtils,
	libtr = require(mp + 'mediawiki.ApiRequest.js'),
	ParsoidConfig = require( mp + 'mediawiki.ParsoidConfig' ).ParsoidConfig,
	MWParserEnvironment = require( mp + 'mediawiki.parser.environment.js' ).MWParserEnvironment,
	TemplateRequest = libtr.TemplateRequest;

var interwikiRE;

/**
 * The global parsoid configuration object.
 * @property {ParsoidConfig}
 */
var parsoidConfig = new ParsoidConfig( localSettings, null );

if ( parsoidConfig.newRelic ) {
	newrelic = require('newrelic');
}

/**
 * The serializer to use for the web requests.
 * @property {Function} Serializer
 */
var Serializer = parsoidConfig.useSelser ? SelectiveSerializer : WikitextSerializer;

/**
 * Get the interwiki regexp.
 *
 * @method
 * @returns {RegExp} The regular expression that matches to all interwikis accepted by the API.
 */
function getInterwikiRE() {
	// this RE won't change -- so, cache it
	if (!interwikiRE) {
		interwikiRE = parsoidConfig.interwikiRegexp;
	}
	return interwikiRE;
}

var htmlSpecialChars = function ( s ) {
	return s.replace(/&/g,'&amp;')
		.replace(/</g,'&lt;')
		.replace(/"/g,'&quot;')
		.replace(/'/g,'&#039;');
};

/**
 * Send a form with a text area.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {string} action Path to post
 * @param {string} name Name of textarea
 * @param {string} content The content we should put in the textarea
 */
var textarea = function ( res, action, name, content ) {
	res.write('<form method=POST action="' + action + '"><textarea name="' + name + '" cols=90 rows=9>');
	res.write( ( content && htmlSpecialChars( content) ) || '' );
	res.write('</textarea><br><input type="submit"></form>');
};

/**
 * Perform word-based diff on a line-based diff. The word-based algorithm is
 * practically unusable for inputs > 5k bytes, so we only perform it on the
 * output of the more efficient line-based diff.
 *
 * @method
 * @param {Array} diff The diff to refine
 * @returns {Array} The refined diff
 */
var refineDiff = function ( diff ) {
	// Attempt to accumulate consecutive add-delete pairs
	// with short text separating them (short = 2 chars right now)
	//
	// This is equivalent to the <b><i> ... </i></b> minimization
	// to expand range of <b> and <i> tags, except there is no optimal
	// solution except as determined by heuristics ("short text" = <= 2 chars).
	function mergeConsecutiveSegments(wordDiffs) {
		var n = wordDiffs.length,
			currIns = null, currDel = null,
			newDiffs = [];
		for (var i = 0; i < n; i++) {
			var d = wordDiffs[i],
				dVal = d.value;
			if (d.added) {
				// Attempt to accumulate
				if (currIns === null) {
					currIns = d;
				} else {
					currIns.value = currIns.value + dVal;
				}
			} else if (d.removed) {
				// Attempt to accumulate
				if (currDel === null) {
					currDel = d;
				} else {
					currDel.value = currDel.value + dVal;
				}
			} else if (((dVal.length < 4) || !dVal.match(/\s/)) && currIns && currDel) {
				// Attempt to accumulate
				currIns.value = currIns.value + dVal;
				currDel.value = currDel.value + dVal;
			} else {
				// Accumulation ends. Purge!
				if (currIns !== null) {
					newDiffs.push(currIns);
					currIns = null;
				}
				if (currDel !== null) {
					newDiffs.push(currDel);
					currDel = null;
				}
				newDiffs.push(d);
			}
		}

		// Purge buffered diffs
		if (currIns !== null) {
			newDiffs.push(currIns);
		}
		if (currDel !== null) {
			newDiffs.push(currDel);
		}

		return newDiffs;
	}

	var added = null,
		out = [];
	for ( var i = 0, l = diff.length; i < l; i++ ) {
		var d = diff[i];
		if ( d.added ) {
			if ( added ) {
				out.push( added );
			}
			added = d;
		} else if ( d.removed ) {
			if ( added ) {
				var fineDiff = jsDiff.diffWords( d.value, added.value );
				fineDiff = mergeConsecutiveSegments(fineDiff);
				out.push.apply( out, fineDiff );
				added = null;
			} else {
				out.push( d );
			}
		} else {
			if ( added ) {
				out.push( added );
				added = null;
			}
			out.push(d);
		}
	}
	if ( added ) {
		out.push(added);
	}
	return out;
};

var roundTripDiff = function ( selser, req, res, env, document ) {
	var patch;
	var out = [];

	var finalCB =  function () {
		var i;
		// XXX TODO FIXME BBQ There should be an error callback in SelSer.
		out = out.join('');
		if ( out === undefined ) {
			console.log( 'Serializer error!' );
			out = "An error occured in the WikitextSerializer, please check the log for information";
			res.send( out, 500 );
			return;
		}
		res.write('<html><head>\n');
		res.write('<script type="text/javascript" src="/jquery.js"></script><script type="text/javascript" src="/scrolling.js"></script><style>ins { background: #ff9191; text-decoration: none; } del { background: #99ff7e; text-decoration: none }; </style>\n');
		// Emit base href so all relative urls resolve properly
		var headNodes = document.firstChild.firstChild.childNodes;
		for (i = 0; i < headNodes.length; i++) {
			if (headNodes[i].nodeName.toLowerCase() === 'base') {
				res.write(DU.serializeNode(headNodes[i]));
				break;
			}
		}
		res.write('</head><body>\n');
		res.write( '<h2>Wikitext parsed to HTML DOM</h2><hr>\n' );
		var bodyNodes = document.body.childNodes;
		for (i = 0; i < bodyNodes.length; i++) {
			res.write(DU.serializeNode(bodyNodes[i]));
		}
		res.write('\n<hr>');
		res.write( '<h2>HTML DOM converted back to Wikitext</h2><hr>\n' );
		res.write('<pre>' + htmlSpecialChars( out ) + '</pre><hr>\n');
		res.write( '<h2>Diff between original Wikitext (green) and round-tripped wikitext (red)</h2><p>(use shift+alt+n and shift+alt+p to navigate forward and backward)<hr>\n' );
		var src = env.page.src.replace(/\n(?=\n)/g, '\n ');
		out = out.replace(/\n(?=\n)/g, '\n ');
		//console.log(JSON.stringify( jsDiff.diffLines( out, src ) ));
		patch = jsDiff.convertChangesToXML( jsDiff.diffLines( src, out ) );
		//patch = jsDiff.convertChangesToXML( refineDiff( jsDiff.diffLines( src, out ) ) );
		res.write( '<pre>\n' + patch + '\n</pre>');
		// Add a 'report issue' link
		res.write('<hr>\n<h2>'+
				'<a style="color: red" ' +
				'href="http://www.mediawiki.org/w/index.php?title=Talk:Parsoid/Todo' +
				'&amp;action=edit&amp;section=new&amp;preloadtitle=' +
				'Issue%20on%20http://parsoid.wmflabs.org' + req.url + '">' +
				'Report a parser issue in this page</a> at ' +
				'<a href="http://www.mediawiki.org/wiki/Talk:Parsoid/Todo">'+
				'[[:mw:Talk:Parsoid/Todo]]</a></h2>\n<hr>');
		res.end('\n</body></html>');
	};

	// Re-parse the HTML to uncover foster-parenting issues
	document = domino.createDocument(document.outerHTML);

	if ( selser ) {
		new SelectiveSerializer( {env: env}).serializeDOM( document.body,
			function ( chunk ) {
				out.push(chunk);
			}, finalCB );
	} else {
		new WikitextSerializer({env: env}).serializeDOM( document.body,
			function ( chunk ) {
				out.push(chunk);
			}, finalCB );
	}
};

function handleCacheRequest (env, req, cb, err, src, cacheErr, cacheSrc) {
	if (cacheErr) {
		// No luck with the cache request, just proceed as normal.
		Util.parse(env, cb, err, src);
		return;
	}
	// Extract transclusion and extension content from the DOM
	var expansions = DU.extractExpansions(DU.parseHTML(cacheSrc));

	// Figure out what we can reuse
	var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}');
	if (parsoidHeader.cacheID) {
		if (parsoidHeader.mode === 'templates') {
			// Transclusions need to be updated, so don't reuse them.
			expansions.transclusions = {};
		} else if (parsoidHeader.mode === 'files') {
			// Files need to be updated, so don't reuse them.
			expansions.files = {};
		}
	}

	// pass those expansions into Util.parse to prime the caches.
	//console.log('expansions:', expansions);
	Util.parse(env, cb, null, src, expansions);
}

var parse = function ( env, req, res, cb, err, src_and_metadata ) {
	var newCb = function ( src, err, doc ) {
		if ( err !== null ) {
			if ( !err.code ) {
				err.code = 500;
			}
			console.error( err.stack || err.toString() );
			res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
			res.send( err.stack || err.toString(), err.code );
			return;
		} else {
			res.setHeader('Content-Type', 'text/html; charset=UTF-8');
			cb( req, res, src, doc );
		}
	};

	// Set the source
	env.setPageSrcInfo( src_and_metadata );

	// Now env.page.meta.title has the canonical title, and
	// env.page.meta.revision.parentid has the predecessor oldid

	// See if we can reuse transclusion or extension expansions.
	if (!err && env.conf.parsoid.parsoidCacheURI &&
			// Don't enter an infinite request loop.
			! /only-if-cached/.test(req.headers['cache-control']))
	{
		// Try to retrieve a cached copy of the content so that we can recycle
		// template and / or extension expansions.
		var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}'),
			// If we get a prevID passed in in X-Parsoid (from our PHP
			// extension), use that explicitly. Otherwise default to the
			// parentID.
			cacheID = parsoidHeader.cacheID ||
				env.page.meta.revision.parentid,
			cacheRequest = new libtr.ParsoidCacheRequest(env,
				env.page.meta.title, cacheID);
		cacheRequest.once('src',
				handleCacheRequest.bind(null, env, req, newCb, err, env.page.src));
	} else {
		handleCacheRequest(env, req, newCb, err, env.page.src, "Recursive request", null);
	}
};

/* -------------------- web app access points below --------------------- */

var app = express.createServer();

// favicon
app.use(express.favicon(path.join(__dirname, "favicon.ico")));

// Increase the form field size limit from the 2M default.
app.use(express.bodyParser({maxFieldsSize: 15 * 1024 * 1024}));

app.get('/', function(req, res){
	// Ignore root in New Relic metrics
	if ( newrelic ) {
		newrelic.setIgnoreTransaction(true);
	}

	res.write('<html><body>\n');
	res.write('<h3>Welcome to the alpha test web service for the ' +
		'<a href="http://www.mediawiki.org/wiki/Parsoid">Parsoid project</a>.</h3>\n');
	res.write( '<p>Usage: <ul><li>GET /title for the DOM. ' +
		'Example: <strong><a href="/en/Main_Page">Main Page</a></strong></li>\n');
	res.write('<li>POST a DOM as parameter "content" to /title for the wikitext</li>\n');
	res.write('</ul>\n');
	res.write('<p>There are also some tools for experiments:\n<ul>\n');
	res.write('<li>Round-trip test pages from the English Wikipedia: ' +
		'<strong><a href="/_rt/en/Help:Magic">/_rt/Help:Magic</a></strong></li>\n');
	res.write('<li><strong><a href="/_rtform/">WikiText -&gt; HTML DOM -&gt; WikiText round-trip form</a></strong></li>\n');
	res.write('<li><strong><a href="/_wikitext/">WikiText -&gt; HTML DOM form</a></strong></li>\n');
	res.write('<li><strong><a href="/_html/">HTML DOM -&gt; WikiText form</a></strong></li>\n');
	res.write('</ul>\n');
	res.write('<p>We are currently focusing on round-tripping of basic formatting like inline/bold, headings, lists, tables and links. Templates, citations and thumbnails are not expected to round-trip properly yet. <strong>Please report issues you see at <a href="http://www.mediawiki.org/w/index.php?title=Talk:Parsoid/Todo&action=edit&section=new">:mw:Talk:Parsoid/Todo</a>. Thanks!</strong></p>\n');
	res.end('</body></html>');
});

function ParserError( msg, stack, code ) {
	Error.call( this, msg );
	this.stack = stack;
	this.code = code;
}

function errorHandler( err, req, res, next ) {
	if ( !(err instanceof ParserError) ) {
		return next( err );
	}

	console.error( 'ERROR in ' + res.locals.iwp + ':' + res.locals.pageName + ':\n' + err.message );
	console.error( "Stack trace: " + err.stack );
	res.send( err.stack, err.code );

	// Force a clean restart of this worker
	process.exit( 1 );
}

app.use( errorHandler );

function defaultParams( req, res, next ) {
	res.locals.iwp = parsoidConfig.defaultWiki || '';
	res.locals.pageName = req.params[0];
	next();
}

function interParams( req, res, next ) {
	res.locals.apiSource = req.params[0];
	res.locals.pageName = req.params[1];
	next();
}

function parserEnvMw( req, res, next ) {
	MWParserEnvironment.getParserEnv( parsoidConfig, null, res.locals.apiSource || res.locals.iwp, res.locals.pageName, req.headers.cookie, function ( err, env ) {
		env.errCB = function ( e ) {
			e = new ParserError(
				e.message,
				e.stack || e.toString(),
				e.code || 500
			);
			next( e );
		};
		if ( err ) {
			return env.errCB( err );
		}
		res.locals.env = env;
		next();
	});
}

// robots.txt: no indexing.
app.get(/^\/robots.txt$/, function ( req, res ) {
	res.end( "User-agent: *\nDisallow: /\n" );
});

// Redirects for old-style URL compatibility
app.get( new RegExp( '^/((?:_rt|_rtve)/)?(' + getInterwikiRE() +
				'):(.*)$' ), function ( req, res ) {
	if ( req.params[0] ) {
		res.redirect(  '/' + req.params[0] + req.params[1] + '/' + req.params[2]);
	} else {
		res.redirect( '/' + req.params[1] + '/' + req.params[2]);
	}
	res.end( );
});

// Bug report posts
app.post( /^\/_bugs\//, function ( req, res ) {
	console.log( '_bugs', req.body.data );
	try {
		var data = JSON.parse( req.body.data ),
			filename = '/mnt/bugs/' +
				new Date().toISOString() +
				'-' + encodeURIComponent(data.title);
		console.log( filename, data );
		fs.writeFile(filename, req.body.data, function(err) {
			if(err) {
				console.error(err);
			} else {
				console.log("The file " + filename + " was saved!");
			}
		});
	} catch ( e ) {
	}
	res.end( );
});

function action( res ) {
	return [ "", res.locals.iwp, res.locals.pageName ].join( "/" );
}

// Form-based HTML DOM -> wikitext interface for manual testing
app.get(/\/_html\/(.*)/, defaultParams, parserEnvMw, function ( req, res ) {
	res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
	res.write( "Your HTML DOM:" );
	textarea( res, action( res ), "html" );
	res.end();
});

// Form-based wikitext -> HTML DOM interface for manual testing
app.get(/\/_wikitext\/(.*)/, defaultParams, parserEnvMw, function ( req, res ) {
	res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
	res.write( "Your wikitext:" );
	textarea( res, action( res ), "wt" );
	res.end();
});

// Round-trip article testing
app.get( new RegExp('/_rt/(' + getInterwikiRE() + ')/(.*)'), interParams, parserEnvMw, function(req, res) {
	var env = res.locals.env;
	req.connection.setTimeout(300 * 1000);

	if ( env.page.name === 'favicon.ico' ) {
		res.send( 'no favicon yet..', 404 );
		return;
	}

	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	console.log('starting parsing of ' + target);
	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}
	var tpr = new TemplateRequest( env, target, oldid );
	tpr.once('src', parse.bind( tpr, env, req, res, roundTripDiff.bind( null, false ) ));
});

// Round-trip article testing with newline stripping for editor-created HTML
// simulation
app.get( new RegExp('/_rtve/(' + getInterwikiRE() + ')/(.*)'), interParams, parserEnvMw, function(req, res) {
	var env = res.locals.env;
	if ( env.page.name === 'favicon.ico' ) {
		res.send( 'no favicon yet..', 404 );
		return;
	}

	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	console.log('starting parsing of ' + target);
	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}
	var tpr = new TemplateRequest( env, target, oldid ),
		cb = function ( req, res, src, document ) {
			// strip newlines from the html
			var html = document.innerHTML.replace(/[\r\n]/g, ''),
				newDocument = DU.parseHTML(html);
			roundTripDiff( false, req, res, src, newDocument );
		};

	tpr.once('src', parse.bind( tpr, env, req, res, cb ));
});

// Round-trip article testing with selser over re-parsed HTML.
app.get( new RegExp('/_rtselser/(' + getInterwikiRE() + ')/(.*)'), interParams, parserEnvMw, function (req, res) {
	var env = res.locals.env;
	if ( env.page.name === 'favicon.ico' ) {
		res.send( 'no favicon yet..', 404 );
		return;
	}

	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	console.log( 'starting parsing of ' + target );
	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}
	var tpr = new TemplateRequest( env, target, oldid ),
		tprCb = function ( req, res, src, document ) {
			var newDocument = DU.parseHTML( DU.serializeNode(document) );
			roundTripDiff( true, req, res, src, newDocument );
		};

	tpr.once( 'src', parse.bind( tpr, env, req, res, tprCb ) );
});

// Form-based round-tripping for manual testing
app.get(/\/_rtform\/(.*)/, defaultParams, parserEnvMw, function ( req, res ) {
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	res.write( "Your wikitext:" );
	textarea( res, "/_rtform/" + res.locals.pageName , "content" );
	res.end();
});

app.post(/\/_rtform\/(.*)/, defaultParams, parserEnvMw, function ( req, res ) {
	var env = res.locals.env;
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	// we don't care about \r, and normalize everything to \n
	parse( env, req, res, roundTripDiff.bind( null, false ), null, {
		revision: { '*': req.body.content.replace(/\r/g, '') }
	});
});

function html2wt( req, res, html ) {
	var env = res.locals.env;
	if ( req.body.oldwt ) {
		env.setPageSrcInfo( req.body.oldwt );
		env.page.id = null;
	} else {
		env.page.id = req.body.oldid || null;
	}

	var doc;
	try {
		doc = DU.parseHTML( html.replace( /\r/g, '' ) );
	} catch ( e ) {
		console.log( 'There was an error in the HTML5 parser! Sending it back to the editor.' );
		env.errCB( e );
		return;
	}

	try {
		var out = [];
		new Serializer( { env: env, oldid: env.page.id } ).serializeDOM(
			doc.body,
			function ( chunk ) {
				out.push( chunk );
			}, function () {
				res.setHeader( 'Content-Type', 'text/x-mediawiki; charset=UTF-8' );
				res.setHeader( 'X-Parsoid-Performance', env.getPerformanceHeader() );
				res.end( out.join( '' ) );
			} );
	} catch ( e ) {
		env.errCB( e );
	}
}

function wt2html( req, res, wt ) {
	var env = res.locals.env;
	var apiSource = res.locals.apiSource;
	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	// Set the timeout to 900 seconds..
	req.connection.setTimeout( 900 * 1000 );

	console.log( 'starting parsing of ' + apiSource + ':' + target );

	if ( env.conf.parsoid.allowCORS ) {
		// allow cross-domain requests (CORS) so that parsoid service
		// can be used by third-party sites
		res.setHeader( 'Access-Control-Allow-Origin',
					   env.conf.parsoid.allowCORS );
	}

	var tmpCb, oldid = null;
	if ( wt ) {
		wt = wt.replace( /\r/g, '' );
		var parser = Util.getParserPipeline( env, 'text/x-mediawiki/full' );
		parser.on( 'document', function ( document ) {
			res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
			// Don't cache requests when wt is set in case somebody uses
			// GET for wikitext parsing
			res.setHeader( 'Cache-Control', 'private,no-cache,s-maxage=0' );
			sendRes( req.body.body ? document.body : document );
		});

		// Set the source
		env.setPageSrcInfo( wt );

		try {
			parser.processToplevelDoc( wt );
		} catch ( e ) {
			env.errCB( e );
			return;
		}
	} else {
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
			if ( !req.headers.cookie ) {
				res.setHeader( 'Cache-Control', 's-maxage=2592000' );
			} else {
				res.setHeader( 'Cache-Control', 'private,no-cache,s-maxage=0' );
			}
			tmpCb = parse.bind( null, env, req, res, function ( req, res, src, doc ) {
				sendRes( doc.documentElement );
			});
		} else {
			// Don't cache requests with a session or no oldid
			res.setHeader( 'Cache-Control', 'private,no-cache,s-maxage=0' );
			tmpCb = function ( err, src_and_metadata ) {
				if ( err ) {
					env.errCB( err );
					return;
				}

				// Set the source
				env.setPageSrcInfo( src_and_metadata );

				// Redirect to oldid
				res.redirect( req.path + "?oldid=" + env.page.meta.revision.revid );
				console.warn( "redirected " + apiSource + ':' + target + " to revision " + env.page.meta.revision.revid );
			};
		}
		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once( 'src', tmpCb );
	}

	function sendRes( doc ) {
		var out = DU.serializeNode( doc );
		var window = domino.createWindow( out );
		var document = window.document;
		Array.prototype.forEach.call( document.querySelectorAll('*'), function( node ) {
			if ( node.hasAttribute( 'style' ) ) node.removeAttribute( 'style' );
			if ( node.hasAttribute( 'data-parsoid' ) ) node.removeAttribute( 'data-parsoid' );
			if ( node.hasAttribute( 'class' ) ) node.removeAttribute( 'class' );
		});
		
		res.setHeader( 'X-Parsoid-Performance', env.getPerformanceHeader() );
		res.end( document.innerHTML );
		console.warn( "completed parsing of " + apiSource + ':' + target + " in " + env.performance.duration + " ms" );
	}
}

// pattern for all routes that do not begin with _
var patternForApiUriOrPrefix = '^[/_](.+)/(.*)';
// Regular article parsing
app.get( new RegExp( patternForApiUriOrPrefix ), interParams, parserEnvMw, function(req, res) {
	var env = res.locals.env;

	// TODO gwicke: re-enable this when actually using Varnish
	//if (/only-if-cached/.test(req.headers['cache-control'])) {
	//	res.send( 'Clearly not cached since this request reached Parsoid. Please fix Varnish.',
	//		404 );
	//	return;
	//}

	wt2html( req, res );
});

// Regular article serialization using POST
app.post( new RegExp( patternForApiUriOrPrefix ), interParams, parserEnvMw, function ( req, res ) {

	// parse html or wt
	if ( req.body.wt ) {
		wt2html( req, res, req.body.wt );
	} else {
		html2wt( req, res, req.body.html ? req.body.html : req.body.content );
	}

});


/**
 * Continuous integration end points
 *
 * No longer used currently, as our testing now happens on the central Jenkins
 * server.
 */
app.get( /\/_ci\/refs\/changes\/(\d+)\/(\d+)\/(\d+)/, function ( req, res ) {
	var gerritChange = 'refs/changes/' + req.params[0] + '/' + req.params[1] + '/' + req.params[2];
	var testSh = spawn( './testGerritChange.sh', [ gerritChange ], {
		cwd: '.'
	} );

	res.setHeader('Content-Type', 'text/xml; charset=UTF-8');

	testSh.stdout.on( 'data', function ( data ) {
		res.write( data );
	} );

	testSh.on( 'exit', function () {
		res.end( '' );
	} );
} );

app.get( /\/_ci\/master/, function ( req, res ) {
	var testSh = spawn( './testGerritMaster.sh', [], {
		cwd: '.'
	} );

	res.setHeader('Content-Type', 'text/xml; charset=UTF-8');

	testSh.stdout.on( 'data', function ( data ) {
		res.write( data );
	} );

	testSh.on( 'exit', function () {
		res.end( '' );
	} );
} );

app.use( express.static( __dirname + '/scripts' ) );
app.use( express.limit( '15mb' ) );

console.log( ' - ' + instanceName + ' ready' );

module.exports = app;
