//#error: XXX uncompilable.

#include <algorithm>

/*
 * Create list tag around list items and map wiki bullet levels to html
 */

//#include "mediawiki/Util.h"

class ListHandler : public TokenEventResponder
{
protected:
	TokenTransformManager& manager;

public:
	ListHandler(manager)
		manager(manager)
	{
		reset();
		manager.addTransform(
			bind(&ListHandler::onListItem, this),
			'listItem', rank, 'tag', 'ListHandler'
		);
		manager.end.connect(bind(&ListHandler::onListItem, this));
	}

	vector<const Token*> bstack;
	vector<const Token*> endtags;
	float listRank = 2.49; // before PostExpandParagraphHandler
	float anyRank = 2.49 + 0.001; // before PostExpandParagraphHandler

	struct TagsMapping
	{
	public:
		TagsMapping(list, item)
		{
		}
		const char* list, item;
	}

	using namespace boost::assign;
	static const map<char, const char*, const char*> bulletCharsMap = map_list_of
		('*', "ul", "li")
		('#', "ol", "li")
		(';', "dl", "dt")
		(':', "dl", "dd")
	;

	void reset()
	{
		newline = false; // flag to identify a list-less line that terminates
							// a list block
		bstack.clear(); // Bullet stack, previous element's listStyle
		endtags.clear();  // Stack of end tags
	}

	TokenList onAny(token, frame, prevToken)
	{
		TokenList tokens;
		if (token.name == "newline") {
			if (newline) {
				// second newline without a list item in between, close the list
				tokens = end().push_back(token);
				this.newline = false;
			} else {
				tokens = [token];
				this.newline = true;
			}
			return { tokens: tokens };
		} else if ( token.constructor === SelfclosingTagTk && token.name === "meta" ) {
			return { token: token };
		} else if ( this.newline ) {
			tokens = this.end().concat( [token] );
			this.newline = false;
			return { tokens: tokens };
		} else {
			return { token: token };
		}
	}

	TokenList onEnd = function( token, frame, prevToken )
	{
		return end().push_back(token);
	}

	TokenList end()
	{
		// pop all open list item tokens
		TokenList tokens = popTags(bstack.size());
		reset();
		manager.removeTransform( anyRank, 'any' );
		return tokens;
	};

ListHandler.prototype.onListItem = function ( token, frame, prevToken ) {
	this.newline = false;
	if (token.constructor === TagTk){
		// convert listItem to list and list item tokens
		return { tokens: this.doListItem(this.bstack, token.bullets, token) };
	}
	return { token: token };
};

ListHandler.prototype.commonPrefixLength = function (x, y) {
	var minLength = min(x.size(), y.size());
	for(var i = 0; i < minLength; i++) {
		if (x[i] != y[i]) break;
	}
	return i;
};

ListHandler.prototype.pushList = function ( container ) {
	this.endtags.push( new EndTagTk( container.list ));
	this.endtags.push( new EndTagTk( container.item ));
	return [
		new TagTk( container.list ),
		new TagTk( container.item )
	];
};

ListHandler.prototype.popTags = function ( n ) {
	var tokens = [];
	for(;n > 0; n--) {
		// push list item..
		tokens.push(this.endtags.pop());
		// and the list end tag
		tokens.push(this.endtags.pop());
	}
	return tokens;
};

ListHandler.prototype.isDtDd = function (a, b) {
	var ab = [a,b].sort();
	return (ab[0] === ':' && ab[1] === ';');
};

	void* doListItem(bs, bn, token)
	{
		int prefixLen = commonPrefixLength(bs, bn);
		int changeLen = max(bs.size(), bn.size()) - prefixLen,
			prefix = bn.slice(0, prefixLen);
		this.newline = false;
		this.bstack = bn;
		if (!bs.size()) {
			this.manager.addTransform( this.onAny.bind(this), "ListHandler:onAny",
					this.anyRank, 'any' );
		}
		
		var itemToken;

		// emit close tag tokens for closed lists
		var res;
		if (changeLen === 0) {
			itemToken = this.endtags.pop();
			this.endtags.push(new EndTagTk( itemToken.name ));
			res = [
				itemToken,
				new TagTk( itemToken.name, [], token.dataAttribs )
			];
		} else {
			var tokens = [];
			if ( bs.size() > prefixLen && 
				 bn.size() > prefixLen && 
				this.isDtDd( bs[prefixLen], bn[prefixLen] ) )
			{
				tokens = this.popTags(bs.size() - prefixLen - 1);
				// handle dd/dt transitions
				var newName = this.bulletCharsMap[bn[prefixLen]].item;
				var endTag = this.endtags.pop();
				this.endtags.push(new EndTagTk( newName ));
				// TODO: review dataAttribs forwarding here and below in
				// doListItem, in particular re accuracy of tsr!
				var newTag = new TagTk(newName, [], token.dataAttribs);
				tokens = tokens.concat([ endTag, newTag ]);
				prefixLen++;
			} else {
				tokens = tokens.concat( this.popTags(bs.size() - prefixLen) );
				if (prefixLen > 0 && bn.size() == prefixLen ) {
					itemToken = this.endtags.pop();
					tokens.push(itemToken);
					tokens.push(new TagTk(itemToken.name, [], token.dataAttribs));
					this.endtags.push(new EndTagTk( itemToken.name ));
				}
			}


			for(var i = prefixLen; i < bn.size(); i++) {
				if (!this.bulletCharsMap[bn[i]])
					throw("Unknown node prefix " + prefix[i]);

				tokens = tokens.concat(this.pushList(this.bulletCharsMap[bn[i]]));
			}
			res = tokens;
		}

		if (this.manager.env.trace) {
			this.manager.env.tracer.output("Returning: " + Util.toStringTokens(res).join(","));
		}
		return res;
	}
}
