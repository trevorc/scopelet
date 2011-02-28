(function() {

function Scope(context, parent) {
  this.context = context;
  this.parent = parent;
}

Scope.prototype.push = function(name, andthen, orelse) {
  var val = this.resolve(name);
  if (val != null) {
    andthen(new Scope(val, this));
  } else if (orelse != null) {
    orelse();
  }
};

Scope.prototype.repeat = function(andthen, orelse) {
  var val = this.context;
  var i;
  if (val != null) {
    if (val.length == null) {
      throw new TypeError('expected array, got ' + typeof val +
          ' (' + JSON.stringify(val) + ')');
    }
    for (i = 0; i < val.length; ++i) {
      andthen(new Scope(val[i], this));
    }
  } else if (orelse != null) {
    orelse();
  }
};

Scope.prototype.resolve = function(name) {
  var parts = name.split('.');
  var scope, i, res;
  if (name === '@') return this.context;
  for (scope = this; scope != null && res == null; scope = scope.parent) {
    res = scope.context[parts[0]];
  }
  for (i = 1; i < parts.length && res != null; ++i) {
    res = res[parts[i]];
  }
  return res;
};

Scope.prototype.expand = function(name) {
  var res = this.resolve(name);
  if (res == null) {
    throw new ReferenceError('could not resolve "' + name + '"');
  }
  return res;
};

var INDENT = 2;

function Compiler(stream) {
  this.stream = stream;
  this.indentLevel = 0;
  this.script = '';
};

Compiler.prototype.consume = function() {
  var n = this.stream.next();
  if (arguments.length > 0 &&
      Array.prototype.indexOf.call(arguments, n.type) === -1) {
    var expected = Array.prototype.join.call(arguments, ', ');
    throw new TypeError('expected ' + expected + ', got ' + n.type +
      ' (' + n.arg + ')');
  }
  return n;
};

Compiler.prototype.emit = function(stmt) {
  this.script += new Array(this.indentLevel).join(' ');
  this.script += stmt;
  this.script += '\n';
};

Compiler.prototype.indent = function() {
  this.indentLevel += INDENT;
};

Compiler.prototype.dedent = function() {
  this.indentLevel -= INDENT;
};

Compiler.prototype.end = function() {
  if (this.consume('OR', 'END').type === 'OR') {
    this.dedent();
    this.emit('}, function() {');
    this.indent();
    this.expression();
    this.consume('END');
  }
  this.dedent();
  this.emit("});");
};

Compiler.prototype.section = function(name, inner) {
  this.emit("ctx.push('" + name + "', function(ctx) {");
  this.indent();
  if (inner == null) {
    this.expression();
  } else {
    inner();
  }
  this.end();
};

Compiler.prototype.repeat = function(name) {
  if (name != null) {
    this.emit("ctx.push('" + name + "', function(ctx) {");
    this.indent();
  }

  this.emit('ctx.repeat(function(ctx) {');
  this.indent();
  this.expression();
  this.end();

  if (name != null) {
    this.dedent();
    this.emit("});");
  }
};

Compiler.prototype.quote = function(str) {
  return str
      .replace(/\\/g, '\\\\')
      .replace(/\'/g, "\\'")
      .replace(/\n/g, '\\n');
};

Compiler.prototype.string = function(str) {
  this.emit("s += '" + this.quote(str) + "';");
};

Compiler.prototype.expand = function(name) {
  this.emit("s += ctx.expand('" + name + "');");
};

Compiler.prototype.expression = function() {
  var n = this.consume();
  switch (n.type) {
    case 'SECTION': this.section(n.arg); return this.expression();
    case 'REPEAT':  this.repeat(n.arg);  return this.expression();
    case 'STRING':  this.string(n.arg);  return this.expression();
    case 'EXPAND':  this.expand(n.arg);  return this.expression();
    case 'EOF':     return 'EOF';
    default: this.stream.pushBack(n); return null;
  }
};

Compiler.prototype.manyExpressions = function() {
  do {
    n = this.expression();
    if (n == null) {
      throw new SyntaxError('expected expression (got ' + n + ')');
    }
  } while (n !== 'EOF');
};

Compiler.prototype.template = function() {
  var n;
  this.indent();
  this.emit("s = '';");
  this.manyExpressions();
  this.emit("return s;");
  this.dedent();
};

Compiler.prototype.toFunction = function() {
  return new Function('ctx', this.script);
};

Compiler.prototype.toString = function() {
  return 'function(ctx) {\n' + this.script + '}\n';
};


function Token(type, arg) {
  this.type = type;
  this.arg = arg;
}

function TokenStream(str) {
  this.str = str;
  this.offset = 0;
  this.state = 'EXPR';
}

TokenStream.prototype.pushState = function(state) {
  this.lastState = this.state;
  this.state = state;
};

TokenStream.prototype.next = function() {
  var m, n, result, rest;

  if (this.offset >= this.str.length) {
    this.pushState('EOF');
    return new Token('EOF');
  }

  rest = this.str.slice(this.offset);

  switch (this.state) {
    case 'EOF':
      throw new Error('EOF');

    case 'EXPR':
      n = rest.indexOf('{');
      if (n === -1) n = rest.length;
      tok = new Token('STRING', rest.slice(0, n));
      n++;
      this.pushState('DIRECTIVE');
      break;

    case 'DIRECTIVE': // {{{{
      m = /^(\.\w+)\s*([\w-]+)?\}|^([^.][^}]*)\}/.exec(rest);
      if (m == null) throw new SyntaxError('expected }, got ' +
          rest.slice(0, 24));
      n = m[0].length;
      if (m[1]) {
        switch (m[1]) {
          case '.section': tok = new Token('SECTION', m[2]); break;
          case '.repeat': tok = new Token('REPEAT', m[2]); break;
          case '.or': tok = new Token('OR'); break;
          case '.end': tok = new Token('END'); break;
          default: throw new SyntaxError('unknown directive ' + m[1]);
        }
      } else {
        tok = new Token('EXPAND', m[3]);
      }
      this.pushState('EXPR');
      break;

  }

  this.offset += n;
  tok.offset = n;
  return tok;
};

TokenStream.prototype.pushBack = function(token) {
  this.offset -= token.offset;
  this.state = this.lastState;
  delete this.lastState;
};


function Template(source) {
  var stream = new TokenStream(source);
  var compiler = new Compiler(stream);
  compiler.template();
  this.fun = compiler.toFunction();
}

Template.prototype.expand = function(context) {
  return this.fun(new Scope(context));
};


this.scopelet = {
  compile: function(source) {
    return new Template(source);
  }
};

}).call(this);
