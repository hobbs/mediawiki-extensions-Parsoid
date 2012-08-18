//#error: XXX uncompilable.

#include <boost/signal.hpp>
#include <boost/bind.hpp>
#include <boost/property_map/property_map.hpp>

typedef string
String;

template <typename value_type>
associative_property_map<String, value_type> StringKeyedMap;

class TokenList : public vector<Token>
{
public:
	TokenList operator+(const TokenList& other)
	{
		insert(end(), other.begin(), other.end());
		return *this;
	}
}

class TokenTransformManager : public TokenEmitter
{
protected:
	struct TokenTransformer
	{
	public:
		TokenTransformer(void* transform, float rank) :
			transform(transform),
			rank(rank)
		{}

		void* transform;
		float rank;
	}

	StringKeyedMap<vector<const TokenTransformer>> tokenTransformers;

public:
	void addTransform(transformation, debug_name, rank, type, name)
	{
		String key = tokenTransformersKey(type, name);

		tokenTransformers[key] = new TokenTransformer(transformation, rank);
	}

protected:
	String tokenTransformersKey(const String tkType, const String tagName) const
	{
		return (tkType == "tag") ? String("tag:") + tagName.toLowerCase() : tkType;
	}

	vector<void*> getTransforms(const Token& token, minRank)
	{
		String key = tokenTransformersKey(tkType, token.name);
	}
}

using namespace boost::signals2;
typedef TokenEvent<handler_T> : public signal<handler_T>

class TokenEmitter
{
public:
	TokenEvent<
		TokenList ()
	>end;

	TokenEvent<
		TokenList (Token, Frame, Token)
	>listItem;
}

class TokenEventResponder
{

	void* respond(const char* event);
}

