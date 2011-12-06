/**
 * Creates an es.IndentationButtonTool object.
 * 
 * @class
 * @constructor
 * @extends {es.ButtonTool}
 * @param {es.ToolbarView} toolbar
 * @param {String} name
 */
 es.IndentationButtonTool = function( toolbar, name, data ) {
	es.ButtonTool.call( this, toolbar, name );
	this.data = data;
};

/* Methods */

es.IndentationButtonTool.prototype.onClick = function() {
	//
};

es.IndentationButtonTool.prototype.updateState = function( annotations, nodes ) {
	// checks if all passed nodes are listItems
	function check( nodes, style ) {
		var parent, styles;
		for( var i = 0; i < nodes.length; i++ ) {
			if ( nodes[i].getParent().getElementType() !== 'listItem' ) {
				return false;
			}
		}
		return true;
	}

	if ( check( nodes, this.name ) ) {
		this.$.removeClass( 'es-toolbarButtonTool-disabled' );
	} else {
		this.$.addClass( 'es-toolbarButtonTool-disabled' );			
	}
};

/* Registration */

es.Tool.tools.indent = {
	constructor: es.IndentationButtonTool,
	name: 'indent'
};

es.Tool.tools.outdent = {
	constructor: es.IndentationButtonTool,
	name: 'outdent'
};

/* Inheritance */

es.extendClass( es.IndentationButtonTool, es.ButtonTool );