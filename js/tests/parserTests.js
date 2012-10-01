/**
 * Initial parser tests runner for experimental JS parser
 *
 * This pulls all the parserTests.txt items and runs them through the JS
 * parser and JS HTML renderer.
 *
 * @author Brion Vibber <brion@pobox.com>
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 * @author Neil Kandalgaonkar <neilk@wikimedia.org>
 */

(function() {

var fs = require('fs'),
	path = require('path'),
	jsDiff = require('diff'),
	colors = require('colors'),
	util = require( 'util' ),
	jsdom = require( 'jsdom' ),
	HTML5 = require('html5').HTML5,  //TODO is this fixup for tests only, or part of real parsing...
	PEG = require('pegjs'),
	// Handle options/arguments with optimist module
	optimist = require('optimist');

// track files imported / required
var fileDependencies = [];

// Fetch up some of our wacky parser bits...

var mp = '../lib/',
	ParserPipelineFactory = require(mp + 'mediawiki.parser.js').ParserPipelineFactory,
	MWParserEnvironment = require(mp + 'mediawiki.parser.environment.js').MWParserEnvironment,
	WikitextSerializer = require(mp + 'mediawiki.WikitextSerializer.js').WikitextSerializer,
	TemplateRequest = require(mp + 'mediawiki.ApiRequest.js').TemplateRequest;

// For now most modules only need this for $.extend and $.each :)
global.$ = require('jquery');

var pj = path.join;

// Our code...

/**
 * Colorize given number if <> 0
 *
 * @param count Integer: a number to colorize
 * @param color String: valid color for the colors library
 */
var colorizeCount = function ( count, color ) {
	if( count === 0 ) {
		return count;
	}

	// We need a string to use colors methods
	count = count.toString();

	// FIXME there must be a wait to call a method by its name
	if ( count[color] ) {
		return count[color];
	} else {
		return count;
	}
};

var testWhiteList = require(__dirname + '/parserTests-whitelist.js').testWhiteList,
	modes = ['wt2wt', 'wt2html', 'html2html', 'html2wt'];

function ParserTests () {
	var i;

	this.cache_file = "parserTests.cache"; // Name of file used to cache the parser tests cases
	this.parser_tests_file = "parserTests.txt";

	this.articles = {};

	// Test statistics
	this.stats = {};
	this.stats.passedTests = 0;
	this.stats.passedTestsManual = 0;
	this.stats.failOutputTests = 0;
	var newModes = {};

	for ( i = 0; i < modes.length; i++ ) {
		newModes[modes[i]] = Util.clone( this.stats );
	}

	this.stats.modes = newModes;
}

/**
 * Get the options from the command line.
 */
ParserTests.prototype.getOpts = function () {
	var default_args = ["Default tests-file: " + this.parser_tests_file,
	                    "Default options   : --wt2html --wt2wt --html2html --whitelist --color"];

	return optimist.usage( 'Usage: $0 [options] [tests-file]\n\n' + default_args.join("\n"), {
		'help': {
			description: 'Show this help message',
			alias: 'h'
		},
		'wt2html': {
			description: 'Wikitext -> HTML(DOM)',
			'default': false,
			'boolean': true
		},
		'html2wt': {
			description: 'HTML(DOM) -> Wikitext',
			'default': false,
			'boolean': true
		},
		'wt2wt': {
			description: 'Roundtrip testing: Wikitext -> DOM(HTML) -> Wikitext',
			'default': false,
			'boolean': true
		},
		'html2html': {
			description: 'Roundtrip testing: HTML(DOM) -> Wikitext -> HTML(DOM)',
			'default': false,
			'boolean': true
		},
		'cache': {
			description: 'Get tests cases from cache file ' + this.cache_file,
			'boolean': true,
			'default': false
		},
		'filter': {
			description: 'Only run tests whose descriptions which match given regex',
			alias: 'regex'
		},
		'disabled': {
			description: 'Run disabled tests (option not implemented)',
			'default': false,
			'boolean': true
		},
		'maxtests': {
			description: 'Maximum number of tests to run',
			'boolean': false
		},
		'quick': {
			description: 'Suppress diff output of failed tests',
			'boolean': true,
			'default': false
		},
		'quiet': {
			description: 'Suppress notification of passed tests (shows only failed tests)',
			'boolean': true,
			'default': false
		},
		'whitelist': {
			description: 'Compare against manually verified parser output from whitelist',
			'default': true,
			'boolean': true
		},
		'printwhitelist': {
			description: 'Print out a whitelist entry for failing tests. Default false.',
			'default': false,
			'boolean': true
		},
		'color': {
			description: 'Enable color output Ex: --no-color',
			'boolean': true,
			'default': true
		},
		'debug': {
			description: 'Print debugging information',
			'default': false,
			'boolean': true
		},
		'trace': {
			description: 'Print trace information (light debugging)',
			'default': false,
			'boolean': true
		},
		xml: {
			description: 'Print output in JUnit XML format.',
			default: false,
			'boolean': true
		}
	}).check( function(argv) {
		if( argv.filter === true ) {
			throw "--filter need an argument";
		}
	}).argv; // keep that
};

/**
 * Get an object holding our tests cases. Eventually from a cache file
 */
ParserTests.prototype.getTests = function ( argv ) {

	// Startup by loading .txt test file
	var testFile;
	try {
		testFile = fs.readFileSync(this.testFileName, 'utf8');
		fileDependencies.push( this.testFileName );
	} catch (e) {
		console.log( e );
	}
	if( !argv.cache ) {
		// Cache not wanted, parse file and return object
		return this.parseTestCase( testFile );
	}

	// Find out modification time of all files depencies and then hashes those
	// as a unique value using sha1.
	var mtimes = '';
	fileDependencies.sort().forEach( function (file) {
		mtimes += fs.statSync( file ).mtime;
	});

	var sha1 = require('crypto').createHash('sha1')
		.update( mtimes ).digest( 'hex' ),
		// Look for a cache_file
		cache_content,
		cache_file_digest;
	try {
		console.log( "Looking for cache file " + this.cache_file );
		cache_content = fs.readFileSync( this.cache_file, 'utf8' );
		// Fetch previous digest
		cache_file_digest = cache_content.match( /^CACHE: (\w+)\n/ )[1];
	} catch( e4 ) {
		// cache file does not exist
	}

	if( cache_file_digest === sha1 ) {
		// cache file match our digest.
		console.log( "Loaded tests cases from cache file" );
		// Return contained object after removing first line (CACHE: <sha1>)
		return JSON.parse( cache_content.replace( /.*\n/, '' ) );
	} else {
		// Write new file cache, content preprended with current digest
		console.log( "Cache file either inexistant or outdated" );
		var parse = this.parseTestCase( testFile );
		if ( parse !== undefined ) {
			console.log( "Writing parse result to " + this.cache_file );
			fs.writeFileSync( this.cache_file,
				"CACHE: " + sha1 + "\n" + JSON.stringify( parse ),
				'utf8'
			);
		}
		// We can now return the parsed object
		return parse;
	}
};

/**
 * Parse given tests cases given as plaintext
 */
ParserTests.prototype.parseTestCase = function ( content ) {
	try {
		return this.testParser.parse(content);
	} catch (e) {
		console.log(e);
	}
	return undefined;
};

ParserTests.prototype.processArticle = function( item, cb ) {
	var norm = this.env.normalizeTitle(item.title);
	//console.log( 'processArticle ' + norm );
	this.articles[norm] = item.text;
	process.nextTick( cb );
};

/* Normalize the expected parser output by parsing it using a HTML5 parser and
 * re-serializing it to HTML. Ideally, the parser would normalize inter-tag
 * whitespace for us. For now, we fake that by simply stripping all newlines.
 */
ParserTests.prototype.normalizeHTML = function (source) {
	// TODO: Do not strip newlines in pre and nowiki blocks!
	source = source.replace(/[\r\n]/g, '');
	try {
		this.htmlparser.parse('<body>' + source + '</body>');
		return this.htmlparser.document.childNodes[0].childNodes[1]
			.innerHTML
			// a few things we ignore for now..
			//.replace(/\/wiki\/Main_Page/g, 'Main Page')
			// do not expect a toc for now
			.replace(/<table[^>]+?id="toc"[^>]*>.+?<\/table>/mg, '')
			// do not expect section editing for now
			.replace(/(<span class="editsection">\[.*?<\/span> *)?<span[^>]+class="mw-headline"[^>]*>(.*?)<\/span>/g, '$2')
			// general class and titles, typically on links
			.replace(/(title|class|rel)="[^"]+"/g, '')
			// strip red link markup, we do not check if a page exists yet
			.replace(/\/index.php\?title=([^']+?)&amp;action=edit&amp;redlink=1/g, '/wiki/$1')
			// the expected html has some extra space in tags, strip it
			.replace(/<a +href/g, '<a href')
			.replace(/href="\/wiki\//g, 'href="')
			.replace(/" +>/g, '">');
	} catch(e) {
        console.log("normalizeHTML failed on" +
				source + " with the following error: " + e);
		console.trace();
		return source;
	}
		
};

// Specialized normalization of the wiki parser output, mostly to ignore a few
// known-ok differences.
ParserTests.prototype.normalizeOut = function ( out ) {
	// TODO: Do not strip newlines in pre and nowiki blocks!
	return out
		.replace(/<span typeof="mw:(?:(?:Placeholder|Nowiki|Object\/Template|Entity))"[^>]*>((?:[^<]+|(?!<\/span).)*)<\/span>/g, '$1')
		.replace(/[\r\n]| (data-parsoid|typeof|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content)="[^">]*"/g, '')
		.replace(/<!--.*?-->\n?/gm, '')
		.replace(/<\/?meta[^>]*>/g, '')
		.replace(/<span[^>]+about="[^]+>/g, '')
		.replace(/<span><\/span>/g, '')
		.replace(/href="(?:\.?\.\/)+/g, 'href="');
};

ParserTests.prototype.formatHTML = function ( source ) {
	// Quick hack to insert newlines before some block level start tags
	return source.replace(
		/(?!^)<((div|dd|dt|li|p|table|tr|td|tbody|dl|ol|ul|h1|h2|h3|h4|h5|h6)[^>]*)>/g, '\n<$1>');
};

ParserTests.prototype.convertHtml2Wt = function( options, processWikitextCB, doc ) {
	var content = options.wt2wt ? doc.body : doc;
	try {
		processWikitextCB(this.serializer.serializeDOM(content));
	} catch (e) {
		processWikitextCB(null, e);
	}
};

ParserTests.prototype.convertWt2Html = function( processHtmlCB, wikitext, error ) {
	if (error) {
		console.error("ERROR: " + error);
		return;
	}
	this.parserPipeline.once('document', processHtmlCB);
	this.env.text = wikitext;
	this.parserPipeline.process(wikitext);
};

/**
 * Process a single test.
 *
 * @arg item {object} this.cases[index]
 * @arg options {object} The options for this test.
 * @arg endCb {function} The callback function we should call when this test is done.
 */
ParserTests.prototype.processTest = function ( item, options, endCb ) {
	if ( !( 'title' in item ) ) {
		console.log( item );
		throw new Error( 'Missing title from test case.' );
	}
	if ( !( 'input' in item ) ) {
		console.log( item );
		throw new Error( 'Missing input from test case ' + item.title );
	}
	if ( !( 'result' in item ) ) {
		console.log( item );
		throw new Error( 'Missing input from test case ' + item.title );
	}

	item.time = {};

	var cb, cb2;
	if ( options.wt2html || options.wt2wt ) {
		if ( options.wt2wt ) {
			// insert an additional step in the callback chain
			// if we are roundtripping
			cb2 = this.processSerializedWT.bind( this, item, options, endCb );
			cb = this.convertHtml2Wt.bind( this, options, cb2 );
		} else {
			cb = this.processParsedHTML.bind( this, item, options, endCb );
		}

		item.time.start = Date.now();
		this.convertWt2Html( cb, item.input );
	} else {
		if ( options.html2html ) {
			// insert an additional step in the callback chain
			// if we are roundtripping
			cb2 = this.processParsedHTML.bind( this, item, options, endCb );
			cb = this.convertWt2Html.bind( this, cb2 );
		} else {
			cb = this.processSerializedWT.bind( this, item, options, endCb );
		}

		item.time.start = Date.now();
		this.htmlparser.parse( '<html><body>' + item.result + '</body></html>' );
		this.convertHtml2Wt( options, cb, this.htmlparser.tree.document.childNodes[0].childNodes[1] );
	}
};

/**
 * Process the results of a test that produces HTML.
 *
 * @arg item {object} this.cases[index]
 * @arg options {object} The options for this test.
 * @arg cb {function} The callback function we should call when this test is done.
 * @arg doc {object} The results of the parse.
 */
ParserTests.prototype.processParsedHTML = function( item, options, cb, doc ) {
	item.time.end = Date.now();

	if (doc.err) {
		options.reportFailure( item );
		console.log('PARSE FAIL', doc.err);
	} else {
		// Check the result vs. the expected result.
		this.checkHTML( item, doc.body.innerHTML, options );
	}

	if ( options.wt2html ) {
		item.done.wt2html = true;
	} else if ( options.html2html ) {
		item.done.html2html = true;
	}

	// Now schedule the next test, if any
	process.nextTick( cb );
};

/**
 * Process the results of a test that produces wikitext.
 *
 * @arg item {object} this.cases[index]
 * @arg options {object} The options for this test.
 * @arg cb {function} The callback function we should call when this test is done.
 * @arg wikitext {string} The results of the parse.
 * @arg error {string} The results of the parse.
 */
ParserTests.prototype.processSerializedWT = function ( item, options, cb, wikitext, error ) {
	item.time.end = Date.now();

	if (error) {
		console.log( error );
		options.reportFailure( item );
		console.log('SERIALIZE FAIL', error);
	} else {
		// Check the result vs. the expected result.
		this.checkWikitext( item, wikitext, options );
	}

	if ( options.wt2wt ) {
		item.done.wt2wt = true;
	} else if ( options.html2wt ) {
		item.done.html2wt = true;
	}

	// Now schedule the next test, if any
	process.nextTick( cb );
};

ParserTests.prototype.diff = function ( a, b, color ) {
	if ( color ) {
		return jsDiff.diffWords( a, b ).map( function ( change ) {
			if ( change.added ) {
				return change.value.green;
			} else if ( change.removed ) {
				return change.value.red;
			} else {
				return change.value;
			}
		}).join('');
	} else {
		var patch = jsDiff.createPatch('wikitext.txt', a, b, 'before', 'after');

		// Strip the header from the patch, we know how diffs work..
		patch = patch.replace(/^[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/, '');

		// Don't care about not having a newline.
		patch = patch.replace( /^\\ No newline at end of file\n/, '' );

		return patch;
	}
};

/**
 * Print a failure message for a test.
 *
 * @arg title {string} The title of the test
 * @arg comments {Array} Any comments associated with the test
 * @arg iopts {object|null} Options from the test file
 * @arg options {object} Options for the test environment (usually a copy of argv)
 * @arg actual {object} The actual results (see printResult for more)
 * @arg expected {object} The expected results (see printResult for more)
 * @arg failure_only {bool} Whether we should print only a failure message, or go on to print the diff
 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
 */
ParserTests.prototype.printFailure = function ( title, comments, iopts, options, actual, expected, failure_only, mode ) {
	this.stats.failOutputTests++;
	this.stats.modes[mode].failOutputTests++;

	if ( !failure_only ) {
		console.log( '=====================================================' );
	}

	console.log( 'FAILED'.red + ': ' + ( title + ( mode ? ( ' (' + mode + ')' ) : '' ) ).yellow );

	if ( !failure_only ) {
		console.log( comments.join('\n') );

		if ( options ) {
			console.log( 'OPTIONS'.cyan + ':' );
			console.log( iopts + '\n' );
		}

		console.log( 'INPUT'.cyan + ':' );
		console.log( actual.input + '\n' );

		console.log( options.getActualExpected( actual, expected, options.getDiff, options.formatHTML, options.color ) );

		if ( options.printwhitelist ) {
			this.printWhitelistEntry( title, actual.raw );
		}
	}
};

/**
 * Print a success method for a test.
 *
 * This method is configurable through the options of the ParserTests object.
 *
 * @arg title {string} The title of the test
 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
 * @arg isWhitelist {bool} Whether this success was due to a whitelisting
 * @arg shouldReport {bool} Whether we should actually output this result, or just count it
 */
ParserTests.prototype.printSuccess = function ( title, mode, isWhitelist, shouldReport ) {
	if ( isWhitelist ) {
		this.stats.passedTestsManual++;
		this.stats.modes[mode].passedTestsManual++;
	} else {
		this.stats.passedTests++;
		this.stats.modes[mode].passedTests++;
	}
	if( !shouldReport ) {
		var outStr = 'PASSED';

		if ( isWhitelist ) {
			outStr += ' (whitelist)';
		}

		outStr = outStr.green + ': ';

		outStr += ( title + ' (' + mode + ')' ).yellow;

		console.log( outStr );
	}
};

/**
 * Print the actual and expected outputs.
 *
 * @arg actual {object} Actual output from the parser. Contains 'raw' and 'normal', the output in different formats
 * @arg expected {object} Expected output for this test. Contains 'raw' and 'normal' as above.
 * @arg getDiff {function} The function we use to get the diff for output (if any)
 * @arg formatHTML {function} A function for making HTML look nicer.
 * @arg color {bool} Whether we should output colorful strings or not.
 *
 * Side effect: Both objects will, after this, have 'formattedRaw' and 'formattedNormal' properties,
 * which are the result of calling ParserTests.prototype.formatHTML() on the 'raw' and 'normal' properties.
 */
ParserTests.prototype.getActualExpected = function ( actual, expected, getDiff, formatHTML, color ) {
	var returnStr = '';
	expected.formattedRaw = formatHTML( expected.raw );
	returnStr += ( color ? 'RAW EXPECTED'.cyan : 'RAW EXPECTED' ) + ':';
	returnStr += expected.formattedRaw + '\n';

	actual.formattedRaw = formatHTML( actual.raw );
	returnStr += ( color ? 'RAW RENDERED'.cyan : 'RAW RENDERED' ) + ':';
	returnStr += actual.formattedRaw + '\n';

	expected.formattedNormal = formatHTML( expected.normal );
	returnStr += ( color ? 'NORMALIZED EXPECTED'.magenta : 'NORMALIZED EXPECTED' ) + ':';
	returnStr += expected.formattedNormal + '\n';

	actual.formattedNormal = formatHTML( actual.normal );
	returnStr += ( color ? 'NORMALIZED RENDERED'.magenta : 'NORMALIZED RENDERED' ) + ':';
	returnStr += actual.formattedNormal + '\n';

	returnStr += ( color ? 'DIFF'.cyan : 'DIFF' ) + ': ';
	returnStr += getDiff( actual, expected, color );

	return returnStr;
};

/**
 * Print the diff between the actual and expected outputs.
 *
 * @arg actual {object} Actual output from the parser. Contains 'formattedNormal', a side effect from 'getActualExpected' above.
 * @arg expected {object} Expected output for this test. Contains 'formattedNormal' as above.
 * @arg color {bool} Do you want color in the diff output?
 */
ParserTests.prototype.getDiff = function ( actual, expected, color ) {
	return this.diff( expected.formattedNormal, actual.formattedNormal, color );
};

/**
 * Print the whitelist entry for a test.
 *
 * @arg title {string} The title of the test.
 * @arg raw {string} The actual raw output from the parser.
 */
ParserTests.prototype.printWhitelistEntry = function ( title, raw ) {
	console.log( 'WHITELIST ENTRY:'.cyan);
	console.log( 'testWhiteList[' +
		JSON.stringify( title ) + '] = ' +
		JSON.stringify( raw ) + ';\n' );
};

/**
 * Print the result of a test.
 *
 * @arg title {string} The title of the test
 * @arg time {object} The times for the test--an object with 'start' and 'end' in milliseconds since epoch.
 * @arg comments {Array} Any comments associated with the test
 * @arg iopts {object|null} Any options for the test (not options passed into the process)
 * @arg expected {object} Expected output for this test. Contains 'raw' and 'normal' as above.
 * @arg actual {object} Actual output from the parser. Contains 'raw' and 'normal', the output in different formats
 * @arg options {object} Options for the test runner. Usually just a copy of argv.
 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
 */
ParserTests.prototype.printResult = function ( title, time, comments, iopts, expected, actual, options, mode ) {
	if ( expected.normal !== actual.normal ) {
		if ( options.whitelist && title in testWhiteList &&
			options.normalizeOut( testWhiteList[title] ) ===  actual.normal ) {
			options.reportSuccess( title, mode, true, options.quiet );
			return;
		}

		options.reportFailure( title, comments, iopts, options, actual, expected, options.quick, mode );
	} else {
		options.reportSuccess( title, mode, false, options.quiet );
	}
};

/**
 * Check the result of a "2html" operation.
 *
 * @arg item {object} The test being run.
 * @arg out {string} The actual output of the parser.
 * @arg options {object} Options for this test and some shared methods.
 */
ParserTests.prototype.checkHTML = function ( item, out, options ) {
	var normalizedOut = this.normalizeOut(out);
	var normalizedExpected = this.normalizeHTML(item.result);

	var mode = (
		options.wt2html ? 'wt2html' : (
			options.html2html ? 'html2html' : 'unknown mode'
		)
	);

	var input = options.html2html ? item.result : item.input;
	var expected = { normal: normalizedExpected, raw: item.result };
	var actual = { normal: normalizedOut, raw: out, input: input };

	options.reportResult( item.title, item.time, item.comments, item.options || null, expected, actual, options, mode );
};

/**
 * Check the result of a "2wt" operation.
 *
 * @arg item {object} The test being run.
 * @arg out {string} The actual output of the parser.
 * @arg options {object} Options passed into the process on the command line.
 */
ParserTests.prototype.checkWikitext = function ( item, out, options ) {
	// FIXME: normalization not in place yet
	var normalizedOut = options.html2wt ? out.replace(/\n+$/, '') : out,
		// FIXME: normalization not in place yet
		normalizedExpected = options.html2wt ? item.input.replace(/\n+$/, '') : item.input;

	var mode = (
		options.wt2wt ? 'wt2wt' : (
			options.html2wt ? 'html2wt' : 'unknown mode'
		)
	);

	var input = options.html2wt ? item.result : item.input;
	var expected = { normal: normalizedExpected, raw: item.input };
	var actual = { normal: normalizedOut, raw: out, input: input };

	options.reportResult( item.title, item.time, item.comments, item.options || null, expected, actual, options, mode );
};

/**
 * Print out a WikiDom conversion of the HTML DOM
 */
ParserTests.prototype.printWikiDom = function ( body ) {
	console.log('WikiDom'.cyan + ':');
	console.log( body );
};

/**
 * Report the summary of all test results to the user.
 *
 * This method is customizable through the options of this ParserTests object.
 *
 * @arg stats {object} The big ol' book of statistics. Members:
 *   failOutputTests: Number of failed tests due to differences in output
 *   passedTests: Number of tests passed without any special consideration
 *   passedTestsManual: Number of tests passed by whitelisting
 *   modes: The above stats per-mode.
 */
ParserTests.prototype.reportSummary = function ( stats ) {
	var curStr, thisMode, i, failTotalTests = stats.failOutputTests;

	console.log( "==========================================================");
	console.log( "SUMMARY: ");

	if( failTotalTests !== 0 ) {
		for ( i = 0; i < modes.length; i++ ) {
			curStr = modes[i] + ': ';
			thisMode = stats.modes[modes[i]];
			if ( thisMode.passedTests + thisMode.passedTestsManual + thisMode.failOutputTests > 0 ) {
				curStr += colorizeCount( thisMode.passedTests, 'green' ) + ' passed / ';
				curStr += colorizeCount( thisMode.passedTestsManual, 'yellow' ) + ' whitelisted / ';
				curStr += colorizeCount( thisMode.failOutputTests, 'red' ) + ' failed';
				console.log( curStr );
			}
		}

		curStr = 'TOTAL' + ': ';
		curStr += colorizeCount( stats.passedTests, 'green' ) + ' passed / ';
		curStr += colorizeCount( stats.passedTestsManual, 'yellow' ) + ' whitelisted / ';
		curStr += colorizeCount( stats.failOutputTests, 'red' ) + ' failed';
		console.log( curStr );

		console.log( '\n' );
		console.log( colorizeCount( stats.passedTests + stats.passedTestsManual, 'green' ) +
			' total passed tests, ' +
			colorizeCount( failTotalTests , 'red'   ) + ' total failures' );
	} else {
		if( this.test_filter !== null ) {
			console.log( "Passed " + ( stats.passedTests + stats.passedTestsManual ) +
					" of " + stats.passedTests + " tests matching " + this.test_filter +
					"... " + "ALL TESTS PASSED!".green );
		} else {
			// Should not happen if it does: Champagne!
			console.log( "Passed " + stats.passedTests + " of " + stats.passedTests +
					" tests... " + "ALL TESTS PASSED!".green );
		}
	}
	console.log( "==========================================================");

};

ParserTests.prototype.main = function ( options ) {
	if ( options.help ) {
		optimist.showHelp();
		process.exit( 0 );
	}

	// Forward this.formatHTML so we don't have unnecessary coupling
	options.formatHTML = this.formatHTML;

	// Forward normalizeOut so we can call it everywhere
	options.normalizeOut = this.normalizeOut;

	if ( !( options.wt2wt || options.wt2html || options.html2wt || options.html2html ) ) {
		options.wt2wt = true;
		options.wt2html = true;
		options.html2html = true;
	}

	if ( typeof options.reportFailure !== 'function' ) {
		// default failure reporting is standard out,
		// see ParserTests::printFailure for documentation of the default.
		options.reportFailure = this.printFailure.bind( this );
	}

	if ( typeof options.reportSuccess !== 'function' ) {
		// default success reporting is standard out,
		// see ParserTests::printSuccess for documentation of the default.
		options.reportSuccess = this.printSuccess.bind( this );
	}

	if ( typeof options.reportStart !== 'function' ) {
		// default summary reporting is standard out,
		// see ParserTests::reportStart for documentation of the default.
		options.reportStart = this.reportStartOfTests.bind( this );
	}

	if ( typeof options.reportSummary !== 'function' ) {
		// default summary reporting is standard out,
		// see ParserTests::reportSummary for documentation of the default.
		options.reportSummary = this.reportSummary.bind( this );
	}

	if ( typeof options.reportResult !== 'function' ) {
		// default result reporting is standard out,
		// see ParserTests::printResult for documentation of the default.
		options.reportResult = this.printResult.bind( this );
	}

	if ( typeof options.getDiff !== 'function' ) {
		// this is the default for diff-getting, but it can be overridden
		// see ParserTests::getDiff for documentation of the default.
		options.getDiff = this.getDiff.bind( this );
	}

	if ( typeof options.getActualExpected !== 'function' ) {
		// this is the default for getting the actual and expected
		// outputs, but it can be overridden
		// see ParserTests::getActualExpected for documentation of the default.
		options.getActualExpected = this.getActualExpected.bind( this );
	}

	this.test_filter = null;
	if ( options.filter ) { // null is the 'default' by definition
		try {
			this.test_filter = new RegExp( options.filter );
		} catch ( e ) {
			console.error( '\nERROR> --filter was given an invalid regular expression.' );
			console.error( 'ERROR> See below for JS engine error:\n' + e + '\n' );
			process.exit( 1 );
		}
		console.log( 'Filtering title test using Regexp ' + this.test_filter );
	}
	if( !options.color ) {
		colors.mode = 'none';
	}

	// Identify tests file
	if ( options._[0] ) {
		this.testFileName = options._[0] ;
	} else {
		this.testFileName = __dirname + '/' + this.parser_tests_file;
	}

	try {
		this.testParser = PEG.buildParser( fs.readFileSync( __dirname + '/parserTests.pegjs', 'utf8' ) );
	} catch ( e2 ) {
		console.log( e2 );
	}

	this.cases = this.getTests( options ) || [];

	if ( options.maxtests ) {
		var n = Number( options.maxtests );
		console.warn( 'maxtests:' + n );
		if ( n > 0 ) {
			this.cases.length = n;
		}
	}

	// Create a new parser environment
	this.env = new MWParserEnvironment({
		fetchTemplates: false,
		debug: options.debug,
		trace: options.trace,
		wgUploadPath: 'http://example.com/images'
	});

	// Create parsers, serializers, ..
	this.htmlparser = new HTML5.Parser();
	if ( options.html2html || options.wt2wt || options.wt2html ) {
		var parserPipelineFactory = new ParserPipelineFactory( this.env );
		this.parserPipeline = parserPipelineFactory.makePipeline( 'text/x-mediawiki/full' );
	}
	if ( options.wt2wt || options.html2wt || options.html2html ) {
		this.serializer = new WikitextSerializer({env: this.env});
	}

	options.reportStart();
	this.env.pageCache = this.articles;
	this.comments = [];
	this.processCase( 0, options );
};

/**
 * Simple function for reporting the start of the tests.
 *
 * This method can be reimplemented in the options of the ParserTests object.
 */
ParserTests.prototype.reportStartOfTests = function () {
	console.log( 'Initialisation complete. Now launching tests.' );
};

ParserTests.prototype.processCase = function ( i, oldOptions ) {
	var options = Util.clone( oldOptions ), oldItem = this.cases[i - 1];
	if ( oldItem ) {
		oldItem = oldItem.done;
		if ( oldItem && ( this.cases[i - 1].passed ||
				oldItem.wt2wt === false || oldItem.wt2html === false
				|| oldItem.html2html === false || oldItem.html2wt === false ) ) {
			return false;
		} else {
			this.cases[i - 1].passed = true;
		}
	}

	var nextCallback = this.processCase.bind( this, i + 1, oldOptions );

	if ( i < this.cases.length ) {
		var item = this.cases[i];
		this.cases[i].done = {};
		//console.log( 'processCase ' + i + JSON.stringify( item )  );
		if ( typeof item === 'object' ) {
			switch(item.type) {
				case 'article':
					this.comments = [];
					this.processArticle( item, nextCallback );
					break;
				case 'test':
					if( this.test_filter &&
						-1 === item.title.search( this.test_filter ) ) {
						// Skip test whose title does not match --filter
						process.nextTick( nextCallback );
						break;
					}
					// Add comments to following test.
					item.comments = this.comments;
					this.comments = [];
					options.wt2wt = false;
					options.wt2html = false;
					options.html2wt = false;
					options.html2html = false;
					if ( oldOptions.wt2wt ) {
						options.wt2wt = true;
						item.done.wt2wt = false;
						this.processTest( item, options, nextCallback );
						options.wt2wt = false;
					}
					if ( oldOptions.wt2html ) {
						options.wt2html = true;
						item.done.wt2html = false;
						this.processTest( item, options, nextCallback );
						options.wt2html = false;
					}
					if ( oldOptions.html2html ) {
						options.html2html = true;
						item.done.html2html = false;
						this.processTest( item, options, nextCallback );
						options.html2html = false;
					}
					if ( oldOptions.html2wt ) {
						options.html2wt = true;
						item.done.html2wt = false;
						this.processTest( item, options, nextCallback );
						options.html2wt = false;
					}
					break;
				case 'comment':
					this.comments.push( item.comment );
					process.nextTick( nextCallback );
					break;
				case 'hooks':
					console.warn('parserTests: Unhandled hook ' + JSON.stringify( item ) );
					break;
				case 'functionhooks':
					console.warn('parserTests: Unhandled functionhook ' + JSON.stringify( item ) );
					break;
				default:
					this.comments = [];
					process.nextTick( nextCallback );
					break;
			}
		} else {
			process.nextTick( nextCallback );
		}
	} else {
		// print out the summary
		// note: these stats won't necessarily be useful if someone
		// reimplements the reporting methods, since that's where we
		// increment the stats.
		options.reportSummary( this.stats );
	}
};

// Construct the ParserTests object and run the parser tests
var ptests = new ParserTests(), popts = ptests.getOpts();

// Note: Wrapping the XML output stuff in its own private world
// so it can have private counters and the like
var xmlFuncs = function () {
	var fail, pass, passWhitelist,

	results = {
		html2html: '',
		wt2wt: '',
		wt2html: '',
		html2wt: ''
	},

	/**
	 * Local helper function for encoding XML entities
	 */
	encodeXml = function ( string ) {
		var xml_special_to_escaped_one_map = {
			'&': '&amp;',
			'"': '&quot;',
			'<': '&lt;',
			'>': '&gt;'
		};

		return string.replace( /([\&"<>])/g, function ( str, item ) {
			return xml_special_to_escaped_one_map[item];
		} );
	},

	/**
	 * Get the actual and expected outputs encoded for XML output.
	 *
	 * @arg actual {object} Actual output from the parser. Contains 'raw' and 'normal', the output in different formats
	 * @arg expected {object} Expected output for this test. Contains 'raw' and 'normal' as above.
	 * @arg getDiff {function} The function we use to get the diff for output (if any)
	 * @arg formatHTML {function} A function for making HTML look nicer.
	 * @arg color {bool} Whether we should output colorful strings or not.
	 *
	 * Side effect: Both objects will, after this, have 'formattedRaw' and 'formattedNormal' properties,
	 * which are the result of calling ParserTests.prototype.formatHTML() on the 'raw' and 'normal' properties.
	 */
	getActualExpectedXML = function ( actual, expected, getDiff, formatHTML, color ) {
		var returnStr = '';

		expected.formattedRaw = formatHTML( expected.raw );
		actual.formattedRaw = formatHTML( actual.raw );
		expected.formattedNormal = formatHTML( expected.normal );
		actual.formattedNormal = formatHTML( actual.normal );

		returnStr += 'RAW EXPECTED:\n';
		returnStr += encodeXml( expected.formattedRaw ) + '\n\n';

		returnStr += 'RAW RENDERED:\n';
		returnStr += encodeXml( actual.formattedRaw ) + '\n\n';

		returnStr += 'NORMALIZED EXPECTED:\n';
		returnStr += encodeXml( expected.formattedNormal ) + '\n\n';

		returnStr += 'NORMALIZED RENDERED:\n';
		returnStr += encodeXml( actual.formattedNormal ) + '\n\n';

		returnStr += 'DIFF:\n';
		returnStr += encodeXml ( getDiff( actual, expected, false ) );

		return returnStr;
	},

	/**
	 * Report the start of the tests output.
	 */
	reportStartXML = function () {
		console.log( '<testsuites>' );
	},

	/**
	 * Report the end of the tests output.
	 */
	reportSummaryXML = function () {
		var i, mode;
		for ( i = 0; i < modes.length; i++ ) {
			mode = modes[i];
			console.log( '<testsuite name="parserTests-' + mode + '" file="parserTests.txt">' );
			console.log( results[mode] );
			console.log( '</testsuite>' );
		}

		console.log( '</testsuites>' );
	},

	/**
	 * Print a failure message for a test in XML.
	 *
	 * @arg title {string} The title of the test
	 * @arg comments {Array} Any comments associated with the test
	 * @arg iopts {object|null} Options from the test file
	 * @arg options {object} Options for the test environment (usually a copy of argv)
	 * @arg actual {object} The actual results (see printResult for more)
	 * @arg expected {object} The expected results (see printResult for more)
	 * @arg failure_only {bool} Whether we should print only a failure message, or go on to print the diff
	 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
	 */
	reportFailureXML = function ( title, comments, iopts, options, actual, expected, failure_only, mode ) {
		fail++;
		var failEle = '<failure type="parserTestsDifferenceInOutputFailure">\n';
		failEle += getActualExpectedXML( actual, expected, options.getDiff, options.formatHTML, false );
		failEle += '\n</failure>\n';
		results[mode] += failEle;
	},

	/**
	 * Print a success method for a test in XML.
	 *
	 * This method is configurable through the options of the ParserTests object.
	 *
	 * @arg title {string} The title of the test
	 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
	 * @arg isWhitelist {bool} Whether this success was due to a whitelisting
	 * @arg shouldReport {bool} Whether we should actually output this result, or just count it
	 */
	reportSuccessXML = function ( title, mode, isWhitelist, shouldReport ) {
		if ( isWhitelist ) {
			passWhitelist++;
		} else {
			pass++;
		}
	},

	/**
	 * Print the result of a test in XML.
	 *
	 * @arg title {string} The title of the test
	 * @arg time {object} The times for the test--an object with 'start' and 'end' in milliseconds since epoch.
	 * @arg comments {Array} Any comments associated with the test
	 * @arg iopts {object|null} Any options for the test (not options passed into the process)
	 * @arg expected {object} Expected output for this test. Contains 'raw' and 'normal' as above.
	 * @arg actual {object} Actual output from the parser. Contains 'raw' and 'normal', the output in different formats
	 * @arg options {object} Options for the test runner. Usually just a copy of argv.
	 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
	 */
	reportResultXML = function ( title, time, comments, iopts, expected, actual, options, mode ) {
		var timeTotal, testcaseEle;

		testcaseEle = '<testcase name="' + encodeXml( title ) + '" ';
		testcaseEle += 'assertions="1" ';

		if ( time && time.end && time.start ) {
			timeTotal = time.end - time.start;
			if ( !isNaN( timeTotal ) ) {
				testcaseEle += 'time="' + ( ( time.end - time.start ) / 1000.0 ) + '"';
			}
		}

		testcaseEle += '>';

		results[mode] += testcaseEle;

		if ( expected.normal !== actual.normal ) {
			if ( options.whitelist && title in testWhiteList &&
				 options.normalizeOut( testWhiteList[title] ) ===  actual.normal ) {
				reportSuccessXML( title, mode, true, options.quiet );
			} else {
				reportFailureXML( title, comments, iopts, options, actual, expected, options.quick, mode );
			}
		} else {
			reportSuccessXML( title, mode, false, options.quiet );
		}

		results[mode] += '</testcase>\n';
	};

	return {
		reportResult: reportResultXML,
		reportStart: reportStartXML,
		reportSummary: reportSummaryXML,
		reportSuccess: reportSuccessXML,
		reportFailure: reportFailureXML
	};
}();

if ( popts && popts.xml ) {
	popts.reportResult = xmlFuncs.reportResult;
	popts.reportStart = xmlFuncs.reportStart;
	popts.reportSummary = xmlFuncs.reportSummary;
}

ptests.main( popts );

} )();
