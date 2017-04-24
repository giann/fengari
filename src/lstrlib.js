"use strict";

const assert  = require('assert');
const sprintf = require('sprintf-js').sprintf;

const lapi    = require('./lapi.js');
const lauxlib = require('./lauxlib.js');
const lobject = require('./lobject.js');
const lua     = require('./lua.js');
const luaconf = require('./luaconf.js');
const llimit  = require('./llimit.js');
const CT      = lua.constant_types;
const char    = lua.char;

const sL_ESC  = '%';
const L_ESC   = char[sL_ESC];

/*
** maximum number of captures that a pattern can do during
** pattern-matching. This limit is arbitrary, but must fit in
** an unsigned char.
*/
const LUA_MAXCAPTURES = 32;

// (sizeof(size_t) < sizeof(int) ? MAX_SIZET : (size_t)(INT_MAX))
const MAXSIZE = 2147483647;

/* Give natural (i.e. strings end at the first \0) length of a string represented by an array of bytes */
const strlen = function(s) {
    let len = s.indexOf(0);
    return len > -1 ? len : s.length;
};

/* translate a relative string position: negative means back from end */
const posrelat = function(pos, len) {
    if (pos >= 0) return pos;
    else if (0 - pos > len) return 0;
    else return len + pos + 1;
};

const str_sub = function(L) {
    let s = lauxlib.luaL_checkstring(L, 1);
    let ts = L.stack[lapi.index2addr_(L, 1)];
    s = ts.value;
    let l = s.length;
    let start = posrelat(lauxlib.luaL_checkinteger(L, 2), l);
    let end = posrelat(lauxlib.luaL_optinteger(L, 3, -1), l);
    if (start < 1) start = 1;
    if (end > l) end = l;
    if (start <= end)
        lapi.lua_pushstring(L, ts.value.slice(start - 1, (start - 1) + (end - start + 1)));
    else lapi.lua_pushliteral(L, "");
    return 1;
};

const str_len = function(L) {
    lapi.lua_pushinteger(L, lauxlib.luaL_checkstring(L, 1).length);
    return 1;
};

const str_char = function(L) {
    let n = lapi.lua_gettop(L);  /* number of arguments */
    let p = [];
    for (let i = 1; i <= n; i++) {
        let c = lauxlib.luaL_checkinteger(L, i);
        lauxlib.luaL_argcheck(L, c >= 0 && c <= 255, "value out of range"); // Strings are 8-bit clean
        p.push(c);
    }
    lapi.lua_pushstring(L, p);
    return 1;
};

const writer = function(L, b, size, B) {
    assert(Array.isArray(b));
    B.push(...b.slice(0, size));
    return 0;
};

const str_dump = function(L) {
    let b = [];
    let strip = lapi.lua_toboolean(L, 2);
    lauxlib.luaL_checktype(L, 1, CT.LUA_TFUNCTION);
    lapi.lua_settop(L, 1);
    if (lapi.lua_dump(L, writer, b, strip) !== 0)
        return lauxlib.luaL_error(L, lua.to_luastring("unable to dump given function"));
    lapi.lua_pushstring(L, b);
    return 1;
};

const SIZELENMOD = luaconf.LUA_NUMBER_FRMLEN.length + 1;

const L_NBFD = 1;

/*
** Add integer part of 'x' to buffer and return new 'x'
*/
const adddigit = function(buff, n, x) {
    let d = Math.floor(x);  /* get integer part from 'x' */
    buff[n] = d < 10 ? d + char['0'] : d - 10 + char['a'];  /* add to buffer */
    return x - d;  /* return what is left */
};

const num2straux = function(x) {
    let buff = [];
    /* if 'inf' or 'NaN', format it like '%g' */
    if (Object.is(x, Infinity))
        return lua.to_luastring('inf', true);
    else if (Object.is(x, -Infinity))
        return lua.to_luastring('-inf', true);
    else if (Number.isNaN(x))
        return lua.to_luastring('nan', true);
    else if (x === 0) {  /* can be -0... */
        /* create "0" or "-0" followed by exponent */
        let zero = sprintf(luaconf.LUA_NUMBER_FMT + "x0p+0", x).split('').map(e => e.charCodeAt(0));
        if (Object.is(x, -0))
            return [char['-']].concat(zero);
        return zero;
    } else {
        let fe = lobject.frexp(x);  /* 'x' fraction and exponent */
        let m = fe[0];
        let e = fe[1];
        let n = 0;  /* character count */
        if (m < 0) {  /* is number negative? */
            buff[n++] = char['-'];  /* add signal */
            m = -m;  /* make it positive */
        }
        buff[n++] = char['0'];
        buff[n++] = char['x'];  /* add "0x" */
        m = adddigit(buff, n++, m * (1 << L_NBFD));  /* add first digit */
        e -= L_NBFD;  /* this digit goes before the radix point */
        if (m > 0) {  /* more digits? */
            buff[n++] = luaconf.lua_getlocaledecpoint().charCodeAt(0);   /* add radix point */
            do {  /* add as many digits as needed */
                m = adddigit(buff, n++, m * 16);
            } while (m > 0);
        }
        let exp = sprintf("p%+d", e).split('').map(e => e.charCodeAt(0));
        return buff.slice(0, n + 1).concat(exp).concat(buff.slice(n));
    }
};

const lua_number2strx = function(L, fmt, x) {
    let buff = num2straux(x);
    if (fmt[SIZELENMOD] === char['A']) {
        for (let i = 0; i < buff.length; i++)
            buff[i] = char[String.fromCharCode(buff[i]).toUpperCase()];
    } else if (fmt[SIZELENMOD] !== char['a'])
        lauxlib.luaL_error(L, lua.to_luastring("modifiers for format '%a'/'%A' not implemented", true));
    return buff;
};

/*
** Maximum size of each formatted item. This maximum size is produced
** by format('%.99f', -maxfloat), and is equal to 99 + 3 ('-', '.',
** and '\0') + number of decimal digits to represent maxfloat (which
** is maximum exponent + 1). (99+3+1 then rounded to 120 for "extra
** expenses", such as locale-dependent stuff)
*/
const MAX_ITEM   = 120;// TODO: + l_mathlim(MAX_10_EXP);


/* valid flags in a format specification */
const FLAGS      = [char["-"], char["+"], char[" "], char["#"], char["0"]];

/*
** maximum size of each format specification (such as "%-099.99d")
*/
const MAX_FORMAT = 32;

// TODO: locale ? and do it better
const isalpha = e => (char['a'] <= e && e <= char['z']) || (e >= char['A'] && e <= char['Z']);
const isdigit = e => char['0'] <= e && e <= char['9'];
const iscntrl = e => (0x00 <= e && e <= 0x1f) || e === 0x7f;
const isgraph = e => e > 32 && e < 127; // TODO: Will only work for ASCII
const islower = e => /^(?![A-Z]).*$/.test(String.fromCharCode(e));
const isupper = e => /^(?![a-z]).*$/.test(String.fromCharCode(e));
const isalnum = e => /^[a-zA-Z0-9]$/.test(String.fromCharCode(e));
const ispunct = e => isgraph(e) && !isalnum(e);
const isspace = e => /^\s$/.test(String.fromCharCode(e));
const isxdigit = e => /^[0-9A-Fa-f]$/.test(String.fromCharCode(e));

// Concat 2 arrays by modifying the first one
const concat = function (a1, a2) {
    for (let i = 0; i < a2.length; i++)
        a1.push(a2[i]);
};

const addquoted = function(b, s) {
    b.push(char['"']);
    let len = s.length;
    while (len--) {
        if (s[0] === char['"'] || s[0] === char['\\'] || s[0] === char['\n']) {
            b.push(char['\\']);
            b.push(s[0]);
        } else if (iscntrl(s[0])) {
            let buff = [];
            if (!isdigit(s[1]))
                buff = lua.to_luastring(sprintf("\\%d", s[0]));
            else
                buff = lua.to_luastring(sprintf("\\%03d", s[0]));
            concat(b, buff);
        } else
            b.push(s[0]);
        s = s.slice(1);
    }
    b.push(char['"']);
};

/*
** Ensures the 'buff' string uses a dot as the radix character.
*/
const checkdp = function(buff) {
    if (buff.indexOf(char['.']) < 0) {  /* no dot? */
        let point = char[luaconf.lua_getlocaledecpoint()];  /* try locale point */
        let ppoint = buff.indexOf(point);
        if (ppoint) buff[ppoint] = '.';  /* change it to a dot */
    }
};

const addliteral = function(L, b, arg) {
    switch(lapi.lua_type(L, arg)) {
        case CT.LUA_TSTRING: {
            let s = lapi.lua_tostring(L, arg);
            addquoted(b, s, s.length);
            break;
        }
        case CT.LUA_TNUMBER: {
            if (!lapi.lua_isinteger(L, arg)) {  /* float? */
                let n = lapi.lua_tonumber(L, arg);  /* write as hexa ('%a') */
                concat(b, lua_number2strx(L, lua.to_luastring(`%${luaconf.LUA_INTEGER_FRMLEN}a`), n));
                checkdp(b);  /* ensure it uses a dot */
            } else {  /* integers */
                let n = lapi.lua_tointeger(L, arg);
                concat(b, lua.to_luastring(sprintf("%d", n)));
            }
            break;
        }
        case CT.LUA_TNIL: case CT.LUA_TBOOLEAN: {
            concat(b, lauxlib.luaL_tolstring(L, arg));
            break;
        }
        default: {
            lauxlib.luaL_argerror(L, arg, lua.to_luastring("value has no literal form", true));
        }
    }
};

const scanformat = function(L, strfrmt, form) {
    let p = strfrmt;
    while (p[0] !== 0 && FLAGS.indexOf(p[0]) >= 0) p = p.slice(1);  /* skip flags */
    if (strfrmt.length - p.length >= FLAGS.length)
        lauxlib.luaL_error(L, lua.to_luastring("invalid format (repeated flags)", true));
    if (isdigit(p[0])) p = p.slice(1);  /* skip width */
    if (isdigit(p[0])) p = p.slice(1);  /* (2 digits at most) */
    if (p[0] === char['.']) {
        p = p.slice(1);
        if (isdigit(p[0])) p = p.slice(1);  /* skip precision */
        if (isdigit(p[0])) p = p.slice(1);  /* (2 digits at most) */
    }
    if (isdigit(p[0]))
        lauxlib.luaL_error(L, lua.to_luastring("invalid format (width or precision too long)", true));
    form[0] = char["%"];
    for (let i = 0; i < strfrmt.length - p.length + 1; i++)
        form[i + 1] = strfrmt[i];
    // form[strfrmt.length - p.length + 2] = 0;
    return {
        form: form,
        p: p
    };
};

/*
** add length modifier into formats
*/
const addlenmod = function(form, lenmod) {
    let l = form.length;
    let lm = lenmod.length;
    let spec = form[l - 1];
    for (let i = 0; i < lenmod.length; i++)
        form[i + l - 1] = lenmod[i];
    form[l + lm - 1] = spec;
    // form[l + lm] = 0;
    return form;
};

const str_format = function(L) {
    let top = lapi.lua_gettop(L);
    let arg = 1;
    let strfrmt = lauxlib.luaL_checkstring(L, arg);
    let b = [];

    while (strfrmt.length > 0) {
        if (strfrmt[0] !== L_ESC) {
            b.push(strfrmt[0]);
            strfrmt = strfrmt.slice(1);
        } else if ((strfrmt = strfrmt.slice(1))[0] === L_ESC) {
            b.push(strfrmt[0]);
            strfrmt = strfrmt.slice(1);
        } else { /* format item */
            let form = [];  /* to store the format ('%...') */
            if (++arg > top)
                lauxlib.luaL_argerror(L, arg, lua.to_luastring("no value", true));
            let f = scanformat(L, strfrmt, form);
            strfrmt = f.p;
            form = f.form;
            switch (String.fromCharCode(strfrmt[0])) {
                case 'c': {
                    strfrmt = strfrmt.slice(1);
                    // concat(b, lua.to_luastring(sprintf(String.fromCharCode(...form), lauxlib.luaL_checkinteger(L, arg))));
                    b.push(lauxlib.luaL_checkinteger(L, arg));
                    break;
                }
                case 'd': case 'i':
                case 'o': case 'u': case 'x': case 'X': {
                    strfrmt = strfrmt.slice(1);
                    let n = lauxlib.luaL_checkinteger(L, arg);
                    form = addlenmod(form, luaconf.LUA_INTEGER_FRMLEN.split('').map(e => e.charCodeAt(0)));
                    concat(b, lua.to_luastring(sprintf(String.fromCharCode(...form), n)));
                    break;
                }
                case 'a': case 'A': {
                    strfrmt = strfrmt.slice(1);
                    form = addlenmod(form, luaconf.LUA_INTEGER_FRMLEN.split('').map(e => e.charCodeAt(0)));
                    concat(b, lua_number2strx(L, form, lauxlib.luaL_checknumber(L, arg)));
                    break;
                }
                case 'e': case 'E': case 'f':
                case 'g': case 'G': {
                    strfrmt = strfrmt.slice(1);
                    let n = lauxlib.luaL_checknumber(L, arg);
                    form = addlenmod(form, luaconf.LUA_INTEGER_FRMLEN.split('').map(e => e.charCodeAt(0)));
                    concat(b, lua.to_luastring(sprintf(String.fromCharCode(...form), n)));
                    break;
                }
                case 'q': {
                    strfrmt = strfrmt.slice(1);
                    addliteral(L, b, arg);
                    break;
                }
                case 's': {
                    strfrmt = strfrmt.slice(1);
                    let s = lauxlib.luaL_tolstring(L, arg);
                    if (form.length <= 2 || form[2] === 0) {  /* no modifiers? */
                        concat(b, s);  /* keep entire string */
                        lapi.lua_pop(L, 1);  /* remove result from 'luaL_tolstring' */
                    } else {
                        lauxlib.luaL_argcheck(L, s.length === strlen(s), arg, lua.to_luastring("string contains zeros", true));
                        if (form.indexOf(char['.']) < 0 && s.length >= 100) {
                            /* no precision and string is too long to be formatted */
                            concat(b, s);  /* keep entire string */
                            lapi.lua_pop(L, 1);  /* remove result from 'luaL_tolstring' */
                        } else {  /* format the string into 'buff' */
                            // TODO: will failt if s is not valid UTF-8
                            concat(b, lua.to_luastring(sprintf(String.fromCharCode(...form), lobject.jsstring(s))));
                            lapi.lua_pop(L, 1);  /* remove result from 'luaL_tolstring' */
                        }
                    }
                    break;
                }
                default: {  /* also treat cases 'pnLlh' */
                    return lauxlib.luaL_error(L, lua.to_luastring(`invalid option '%${String.fromCharCode(strfrmt[0])}'`));
                }
            }
        }
    }

    lapi.lua_pushstring(L, b);
    return 1;
};

/* value used for padding */
const LUAL_PACKPADBYTE = 0x00;

/* maximum size for the binary representation of an integer */
const MAXINTSIZE = 16;

const SZINT = 8; // Size of lua_Integer

/* number of bits in a character */
const NB = 8;

/* mask for one character (NB 1's) */
const MC = ((1 << NB) - 1);

const MAXALIGN = 8;

/*
** information to pack/unpack stuff
*/
class Header {
    constructor(L) {
        this.L = L;
        this.islittle = true;
        this.maxalign = 1;
    }
}

/*
** options for pack/unpack
*/
const KOption = {
    Kint:       0, /* signed integers */
    Kuint:      1, /* unsigned integers */
    Kfloat:     2, /* floating-point numbers */
    Kchar:      3, /* fixed-length strings */
    Kstring:    4, /* strings with prefixed length */
    Kzstr:      5, /* zero-terminated strings */
    Kpadding:   6, /* padding */
    Kpaddalign: 7, /* padding for alignment */
    Knop:       8  /* no-op (configuration or spaces) */
};

const digit = function(c) {
    return char['0'] <= c && c <= char['9'];
};

const getnum = function(fmt, df) {
    if (!digit(fmt.s[0]))  /* no number? */
        return df;  /* return default value */
    else {
        let a = 0;
        do {
            a = a * 10 + (fmt.s[0] - char['0']);
            fmt.s = fmt.s.slice(1);
        } while (digit(fmt.s[0]) && a <= (MAXSIZE - 9)/10);
        return a;
    }
};

/*
** Read an integer numeral and raises an error if it is larger
** than the maximum size for integers.
*/
const getnumlimit = function(h, fmt, df) {
    let sz = getnum(fmt, df);
    if (sz > MAXINTSIZE || sz <= 0)
        lauxlib.luaL_error(h.L, lua.to_luastring(`integral size (${sz}) out of limits [1,${MAXINTSIZE}]`));
    return sz;
};

/*
** Read and classify next option. 'size' is filled with option's size.
*/
const getoption = function(h, fmt) {
    let r = {
        opt: NaN,
        size: NaN
    };

    r.opt = fmt.s[0];
    fmt.s = fmt.s.slice(1);
    r.size = 0;  /* default */
    switch (r.opt) {
        case char['b']: r.size = 1; r.opt = KOption.Kint;   return r; // sizeof(char): 1
        case char['B']: r.size = 1; r.opt = KOption.Kuint;  return r;
        case char['h']: r.size = 2; r.opt = KOption.Kint;   return r; // sizeof(short): 2
        case char['H']: r.size = 2; r.opt = KOption.Kuint;  return r;
        case char['l']: r.size = 8; r.opt = KOption.Kint;   return r; // sizeof(long): 8
        case char['L']: r.size = 8; r.opt = KOption.Kuint;  return r;
        case char['j']: r.size = 8; r.opt = KOption.Kint;   return r; // sizeof(lua_Integer): 8
        case char['J']: r.size = 8; r.opt = KOption.Kuint;  return r;
        case char['T']: r.size = 8; r.opt = KOption.Kuint;  return r; // sizeof(size_t): 8
        case char['f']: r.size = 4; r.opt = KOption.Kfloat; return r; // sizeof(float): 4
        case char['d']: r.size = 8; r.opt = KOption.Kfloat; return r; // sizeof(double): 8
        case char['n']: r.size = 8; r.opt = KOption.Kfloat; return r; // sizeof(lua_Number): 8
        case char['i']: r.size = getnumlimit(h, fmt, 4); r.opt = KOption.Kint;    return r; // sizeof(int): 4
        case char['I']: r.size = getnumlimit(h, fmt, 4); r.opt = KOption.Kuint;   return r;
        case char['s']: r.size = getnumlimit(h, fmt, 8); r.opt = KOption.Kstring; return r;
        case char['c']: {
            r.size = getnum(fmt, -1);
            if (r.size === -1)
                lauxlib.luaL_error(h.L, lua.to_luastring("missing size for format option 'c'", true));
            r.opt = KOption.Kchar;
            return r;
        }
        case char['z']:             r.opt = KOption.Kzstr;      return r;
        case char['x']: r.size = 1; r.opt = KOption.Kpadding;   return r;
        case char['X']:             r.opt = KOption.Kpaddalign; return r;
        case char[' ']: break;
        case char['<']: h.islittle = true; break;
        case char['>']: h.islittle = false; break;
        case char['=']: h.islittle = true; break;
        case char['!']: h.maxalign = getnumlimit(h, fmt, MAXALIGN); break;
        default: lauxlib.luaL_error(h.L, lua.to_luastring(`invalid format option '${String.fromCharCode(r.opt)}'`));
    }

    r.opt = KOption.Knop;
    return r;
};

/*
** Read, classify, and fill other details about the next option.
** 'psize' is filled with option's size, 'notoalign' with its
** alignment requirements.
** Local variable 'size' gets the size to be aligned. (Kpadal option
** always gets its full alignment, other options are limited by
** the maximum alignment ('maxalign'). Kchar option needs no alignment
** despite its size.
*/
const getdetails = function(h, totalsize, fmt) {
    let r = {
        opt: NaN,
        size: NaN,
        ntoalign: NaN
    };

    let opt = getoption(h, fmt);
    r.size = opt.size;
    r.opt = opt.opt;
    let align = r.size;  /* usually, alignment follows size */
    if (r.opt === KOption.Kpaddalign) {  /* 'X' gets alignment from following option */
        if (fmt.s[0] === 0)
            lauxlib.luaL_argerror(h.L, 1, lua.to_luastring("invalid next option for option 'X'", true));
        else {
            let o = getoption(h, fmt);
            align = o.size;
            o = o.opt;
            if (o === KOption.Kchar || align === 0)
                lauxlib.luaL_argerror(h.L, 1, lua.to_luastring("invalid next option for option 'X'", true));
        }
    }
    if (align <= 1 || r.opt === KOption.Kchar)  /* need no alignment? */
        r.ntoalign = 0;
    else {
        if (align > h.maxalign)  /* enforce maximum alignment */
            align = h.maxalign;
        if ((align & (align -1)) !== 0)  /* is 'align' not a power of 2? */
            lauxlib.luaL_argerror(h.L, 1, lua.to_luastring("format asks for alignment not power of 2", true));
        r.ntoalign = (align - (totalsize & (align - 1))) & (align - 1);
    }
    return r;
};

/*
** Pack integer 'n' with 'size' bytes and 'islittle' endianness.
** The final 'if' handles the case when 'size' is larger than
** the size of a Lua integer, correcting the extra sign-extension
** bytes if necessary (by default they would be zeros).
*/
const packint = function(b, n, islittle, size, neg) {
    let buff = new Array(size);

    buff[islittle ? 0 :  size - 1] = n & MC;  /* first byte */
    for (let i = 1; i < size; i++) {
        n >>= NB;
        buff[islittle ? i : size - 1 - i] = n & MC;
    }
    if (neg && size > SZINT) {  /* negative number need sign extension? */
        for (let i = SZINT; i < size; i++)  /* correct extra bytes */
            buff[islittle ? i : size - 1 - i] = MC;
    }
    b.push(...buff);  /* add result to buffer */
};

const packnum = function(b, n, islittle, size) {
    let dv = new DataView(new ArrayBuffer(size));
    dv.setFloat64(0, n, islittle);

    for (let i = 0; i < 8; i++)
        b.push(dv.getUint8(i, islittle));
};

const str_pack = function(L) {
    let b = [];
    let h = new Header(L);
    let fmt = lauxlib.luaL_checkstring(L, 1);  /* format string */
    fmt.push(0); // Add \0 to avoid overflow
    fmt = {
        s: fmt,
        off: 0
    };
    let arg = 1;  /* current argument to pack */
    let totalsize = 0;  /* accumulate total size of result */
    lapi.lua_pushnil(L);  /* mark to separate arguments from string buffer */
    while (fmt.s.length - 1 > 0) {
        let details = getdetails(h, totalsize, fmt);
        let opt = details.opt;
        let size = details.size;
        let ntoalign = details.ntoalign;
        totalsize += ntoalign + size;
        while (ntoalign-- > 0)
            b.push(LUAL_PACKPADBYTE);  /* fill alignment */
        arg++;
        switch (opt) {
            case KOption.Kint: {  /* signed integers */
                let n = lauxlib.luaL_checkinteger(L, arg);
                if (size < SZINT) {  /* need overflow check? */
                    let lim = 1 << (size * 8) - 1;
                    lauxlib.luaL_argcheck(L, -lim <= n && n < lim, arg, lua.to_luastring("integer overflow", true));
                }
                packint(b, n, h.islittle, size, n < 0);
                break;
            }
            case KOption.Kuint: {  /* unsigned integers */
                let n = lauxlib.luaL_checkinteger(L, arg);
                if (size < SZINT)
                    lauxlib.luaL_argcheck(L, n < (1 << (size * NB)), arg, lua.to_luastring("unsigned overflow", true));
                packint(b, n, h.islittle, size, false);
                break;
            }
            case KOption.Kfloat: {  /* floating-point options */
                let n = lauxlib.luaL_checknumber(L, arg);  /* get argument */
                packnum(b, n, h.islittle, size);
                break;
            }
            case KOption.Kchar: {  /* fixed-size string */
                let s = lauxlib.luaL_checkstring(L, arg);
                let len = s.length;
                lauxlib.luaL_argcheck(L, len <= size, arg, lua.to_luastring("string long than given size", true));
                b.push(...s);  /* add string */
                while (len++ < size)  /* pad extra space */
                    b.push(LUAL_PACKPADBYTE);
                break;
            }
            case KOption.Kstring: {  /* strings with length count */
                let s = lauxlib.luaL_checkstring(L, arg);
                let len = s.length;
                lauxlib.luaL_argcheck(L, size >= NB || len < (1 << size * NB), arg, lua.to_luastring("string length does not fit in given size", true));
                packint(b, len, h.islittle, size, 0);  /* pack length */
                b.push(...s);
                totalsize += len;
                break;
            }
            case KOption.Kzstr: {  /* zero-terminated string */
                let s = lauxlib.luaL_checkstring(L, arg);
                let len = s.length;
                lauxlib.luaL_argcheck(L, s.length === String.fromCharCode(...s).length, arg, lua.to_luastring("strings contains zeros", true));
                b.push(...s);
                b.push(0);  /* add zero at the end */
                totalsize += len + 1;
                break;
            }
            case KOption.Kpadding: b.push(LUAL_PACKPADBYTE);
            case KOption.Kpaddalign: case KOption.Knop:
                arg--;  /* undo increment */
                break;
        }
    }
    lapi.lua_pushstring(L, b);
    return 1;
};

const str_reverse = function(L) {
    lapi.lua_pushstring(L, lauxlib.luaL_checkstring(L, 1).reverse());
    return 1;
};

const str_lower = function(L) {
    // TODO: will fail on invalid UTF-8
    lapi.lua_pushstring(L, lua.to_luastring(lobject.jsstring(lauxlib.luaL_checkstring(L, 1)).toLowerCase()));
    return 1;
};

const str_upper = function(L) {
    // TODO: will fail on invalid UTF-8
    lapi.lua_pushstring(L, lua.to_luastring(lobject.jsstring(lauxlib.luaL_checkstring(L, 1)).toUpperCase()));
    return 1;
};

const str_rep = function(L) {
    let s = lauxlib.luaL_checkstring(L, 1);
    let n = lauxlib.luaL_checkinteger(L, 2);
    let sep = lauxlib.luaL_optstring(L, 3, []);

    if (s.length + sep.length < s.length || s.length + sep.length > MAXSIZE / n)  /* may overflow? */
        return lauxlib.luaL_error(L, lua.to_luastring("resulting string too large", true));

    let r = [];
    for (let i = 0; i < n - 1; i++)
        r = r.concat(s.concat(sep));
    r = r.concat(s);

    lapi.lua_pushstring(L, n > 0 ? r : []);
    return 1;
};

const str_byte = function(L) {
    let s = lauxlib.luaL_checkstring(L, 1);
    let l = s.length;
    let posi = posrelat(lauxlib.luaL_optinteger(L, 2, 1), l);
    let pose = posrelat(lauxlib.luaL_optinteger(L, 3, posi), l);

    if (posi < 1) posi = 1;
    if (pose > l) pose = l;
    if (posi > pose) return 0;  /* empty interval; return no values */
    if (pose - posi >= llimit.MAX_INT)  /* arithmetic overflow? */
        return lauxlib.luaL_error(L, lua.to_luastring("string slice too long", true));

    let n = (pose - posi) + 1;
    lauxlib.luaL_checkstack(L, n, lua.to_luastring("string slice too long", true));
    for (let i = 0; i < n; i++)
        lapi.lua_pushinteger(L, s[posi + i - 1]);
    return n;
};

const str_packsize = function(L) {
    let h = new Header(L);
    let fmt = lauxlib.luaL_checkstring(L, 1);
    fmt.push(0); // Add \0 to avoid overflow
    fmt = {
        s: fmt,
        off: 0
    };
    let totalsize = 0;  /* accumulate total size of result */
    while (fmt.s.length - 1 > 0) {
        let details = getdetails(h, totalsize, fmt);
        let opt = details.opt;
        let size = details.size;
        let ntoalign = details.ntoalign;
        size += ntoalign;  /* total space used by option */
        lauxlib.luaL_argcheck(L, totalsize <= MAXSIZE - size - 1, lua.to_luastring("format result too large", true));
        totalsize += size;
        switch (opt) {
            case KOption.Kstring:  /* strings with length count */
            case KOption.Kzstr:    /* zero-terminated string */
                lauxlib.luaL_argerror(L, 1, lua.to_luastring("variable-length format", true));
            default:  break;
        }
    }
    lapi.lua_pushinteger(L, totalsize);
    return 1;
};

/*
** Unpack an integer with 'size' bytes and 'islittle' endianness.
** If size is smaller than the size of a Lua integer and integer
** is signed, must do sign extension (propagating the sign to the
** higher bits); if size is larger than the size of a Lua integer,
** it must check the unread bytes to see whether they do not cause an
** overflow.
*/
const unpackint = function(L, str, islittle, size, issigned) {
    let res = 0;
    let limit = size <= SZINT ? size : SZINT;
    for (let i = limit - 1; i >= 0; i--) {
        res <<= NB;
        res |= str[islittle ? i : size - 1 - i];
    }
    if (size < SZINT) {  /* real size smaller than lua_Integer? */
        if (issigned) {  /* needs sign extension? */
            let mask = 1 << (size * NB - 1);
            res = ((res ^ mask) - mask);  /* do sign extension */
        }
    } else if (size > SZINT) {  /* must check unread bytes */
        let mask = issigned || res >= 0 ? 0 : MC;
        for (let i = limit; i < size; i++) {
            if (str[islittle ? i : size - 1 - i] !== mask)
                lauxlib.luaL_error(L, lua.to_luastring(`${size}-byte integer does not fit into Lua Integer`));
        }
    }
    return res;
};

const unpacknum = function(L, b, islittle, size) {
    assert(b.length >= size);

    let dv = new DataView(new ArrayBuffer(size));
    b.forEach((e, i) => dv.setUint8(i, e, islittle));

    return dv.getFloat64(0, islittle);
};

const str_unpack = function(L) {
    let h = new Header(L);
    let fmt = lauxlib.luaL_checkstring(L, 1);
    fmt.push(0); // Add \0 to avoid overflow
    fmt = {
        s: fmt,
        off: 0
    };
    let data = lauxlib.luaL_checkstring(L, 2);
    let ld = data.length;
    let pos = posrelat(lauxlib.luaL_optinteger(L, 3, 1), ld) - 1;
    let n = 0;  /* number of results */
    lauxlib.luaL_argcheck(L, pos <= ld, 3, lua.to_luastring("initial position out of string", true));
    while (fmt.s.length - 1 > 0) {
        let details = getdetails(h, pos, fmt);
        let opt = details.opt;
        let size = details.size;
        let ntoalign = details.ntoalign;
        if (/*ntoalign + size > ~pos ||*/ pos + ntoalign + size > ld)
            lauxlib.luaL_argerror(L, 2, lua.to_luastring("data string too short", true));
        pos += ntoalign;  /* skip alignment */
        /* stack space for item + next position */
        lauxlib.luaL_checkstack(L, 2, lua.to_luastring("too many results", true));
        n++;
        switch (opt) {
            case KOption.Kint:
            case KOption.Kuint: {
                let res = unpackint(L, data.slice(pos), h.islittle, size, opt === KOption.Kint);
                lapi.lua_pushinteger(L, res);
                break;
            }
            case KOption.Kfloat: {
                let res = unpacknum(L, data.slice(pos), h.islittle, size);
                lapi.lua_pushnumber(L, res);
                break;
            }
            case KOption.Kchar: {
                lapi.lua_pushstring(L, data.slice(pos, pos + size));
                break;
            }
            case KOption.Kstring: {
                let len = unpackint(L, data.slice(pos), h.islittle, size, 0);
                lauxlib.luaL_argcheck(L, pos + len + size <= ld, 2, lua.to_luastring("data string too short", true));
                lapi.lua_pushstring(L, data.slice(pos + size, pos + size + len));
                pos += len;  /* skip string */
                break;
            }
            case KOption.Kzstr: {
                let len = data.slice(pos).indexOf(0);
                lapi.lua_pushstring(L, data.slice(pos, pos + len));
                pos += len + 1;  /* skip string plus final '\0' */
                break;
            }
            case KOption.Kpaddalign: case KOption.Kpadding: case KOption.Knop:
                n--;  /* undo increment */
                break;
        }
        pos += size;
    }
    lapi.lua_pushinteger(L, pos + 1);  /* next position */
    return n + 1;
};

const CAP_UNFINISHED = -1;
const CAP_POSITION   = -2;
const MAXCCALLS      = 200;
const SPECIALS       = [char["^"], char["$"], char["*"], char["+"], char["?"], char["."], char["("], char["["], char["%"], char["-"]];

class MatchState {
    constructor(L) {
        this.src = null;  /* unmodified source string */
        this.src_init = null;  /* init of source string */
        this.src_end = null;  /* end ('\0') of source string */
        this.p = null;  /* unmodified pattern string */
        this.p_end = null;  /* end ('\0') of pattern */
        this.L = L;
        this.matchdepth = NaN;  /* control for recursive depth */
        this.level = NaN;  /* total number of captures (finished or unfinished) */
        this.capture = [];
    }
}

const check_capture = function(ms, l) {
    l = l - char['1'];
    if (l < 0 || l >= ms.level || ms.capture[l].len === CAP_UNFINISHED)
        return lauxlib.luaL_error(ms.L, lua.to_luastring(`invalid capture index %${l + 1}`));
    return l;
};

const capture_to_close = function(ms) {
    let level = ms.level;
    for (level--; level >= 0; level--)
        if (ms.capture[level].len === CAP_UNFINISHED) return level;
    return lauxlib.luaL_error(ms.L, lua.to_luastring("invalid pattern capture", true));
};

const classend = function(ms, p) {
    switch(ms.p[p++]) {
        case L_ESC: {
            if (p === ms.p_end)
                lauxlib.luaL_error(ms.L, lua.to_luastring("malformed pattern (ends with '%')", true));
            return p + 1;
        }
        case char['[']: {
            if (ms.p[p] === char['^']) p++;
            do {  /* look for a ']' */
                if (p === ms.p_end)
                    lauxlib.luaL_error(ms.L, lua.to_luastring("malformed pattern (missing ']')", true));
                if (ms.p[p++] === L_ESC && p < ms.p_end)
                    p++;  /* skip escapes (e.g. '%]') */
            } while (ms.p[p] !== char[']']);
            return p + 1;
        }
        default: {
            return p;
        }
    }
};

const match_class = function(c, cl) {
    let res;
    switch (String.fromCharCode(cl).toLowerCase().charCodeAt(0)) {
        case char['a'] : res = isalpha(c); break;
        case char['c'] : res = iscntrl(c); break;
        case char['d'] : res = isdigit(c); break;
        case char['g'] : res = isgraph(c); break;
        case char['l'] : res = islower(c); break;
        case char['p'] : res = ispunct(c); break;
        case char['s'] : res = isspace(c); break;
        case char['u'] : res = isupper(c); break;
        case char['w'] : res = isalnum(c); break;
        case char['x'] : res = isxdigit(c); break;
        case char['z'] : res = (c === 0); break;  /* deprecated option */
        default: return (cl === c);
    }
    return (islower(cl) ? res : !res);
};

const matchbracketclass = function(ms, c, p, ec) {
    let sig = true;
    if (ms.p[p + 1] === char['^']) {
        sig = false;
        p++;  /* skip the '^' */
    }
    while (++p < ec) {
        if (ms.p[p] === L_ESC) {
            p++;
            if (match_class(c, ms.p[p]))
                return sig;
        } else if (ms.p[p + 1] === char['-'] && p + 2 < ec) {
            p += 2;
            if (ms.p[p - 2] <= c && c <= ms.p[p])
                return sig;
        } else if (ms.p[p] === c) return sig;
    }
    return !sig;
};

const singlematch = function(ms, s, p, ep) {
    if (s >= ms.src_end)
        return false;
    else {
        let c = ms.src[s];
        switch (ms.p[p]) {
            case char['.']: return true;  /* matches any char */
            case L_ESC: return match_class(c, ms.p[p + 1]);
            case char['[']: return matchbracketclass(ms, c, p, ep - 1);
            default: return ms.p[p] === c;
        }
    }
};

const matchbalance = function(ms, s, p) {
    if (p >= ms.p_end - 1)
        lauxlib.luaL_error(ms.L, lua.to_luastring("malformed pattern (missing arguments to '%b'", true));
    if (ms.src[s] !== ms.p[p])
        return null;
    else {
        let b = ms.p[p];
        let e = ms.p[p + 1];
        let cont = 1;
        while (++s < ms.src_end) {
            if (ms.src[s] === e) {
                if (--cont === 0) return s + 1;
            }
            else if (s === b) cont++;
        }
    }
    return null;  /* string ends out of balance */
};

const max_expand = function(ms, s, p, ep) {
    let i = 0;  /* counts maximum expand for item */
    while (singlematch(ms, s + i, p, ep))
        i++;
    /* keeps trying to match with the maximum repetitions */
    while (i >= 0) {
        let res = match(ms, s + i, ep + 1);
        if (res) return res;
        i--;  /* else didn't match; reduce 1 repetition to try again */
    }
    return null;
};

const min_expand = function(ms, s, p, ep) {
    for (;;) {
        let res = match(ms, s, ep + 1);
        if (res !== null)
            return res;
        else if (singlematch(ms, s, p, ep))
            s++;  /* try with one more repetition */
        else return null;
    }
};

const start_capture = function(ms, s, p, what) {
    let level = ms.level;
    if (level >= LUA_MAXCAPTURES) lauxlib.luaL_error(ms.L, lua.to_luastring("too many captures", true));
    ms.capture[level] = ms.capture[level] ? ms.capture[level] : {};
    ms.capture[level].init = s;
    ms.capture[level].len = what;
    ms.level = level + 1;
    let res;
    if ((res = match(ms, s, p)) === null)  /* match failed? */
        ms.level--;  /* undo capture */
    return res;
};

const end_capture = function(ms, s, p) {
    let l = capture_to_close(ms);
    ms.capture[l].len = s - ms.capture[l].init;  /* close capture */
    let res;
    if ((res = match(ms, s, p)) === null)  /* match failed? */
        ms.capture[l].len = CAP_UNFINISHED;  /* undo capture */
    return res;
};

const match_capture = function(ms, s, l) {
    l = check_capture(ms, l);
    let len = ms.capture[l].len;
    if (ms.src_end >= len && ms.src.slice(ms.capture[l].init, ms.capture[l].init + len) === ms.src.slice(s, s + len))
        return s+len;
    else return null;
};

const match = function(ms, s, p) {
    let gotodefault = false;
    let gotoinit = true;

    if (ms.matchdepth-- === 0)
        lauxlib.luaL_error(ms.L, lua.to_luastring("pattern too complex", true));

    while (gotoinit || gotodefault) {
        gotoinit = false;
        if (p !== ms.p_end) {  /* end of pattern? */
            switch (gotodefault ? char['x'] : ms.p[p]) {
                case char['(']: {  /* start capture */
                    if (ms.p[p + 1] === char[')'])  /* position capture? */
                        s = start_capture(ms, s, p + 2, CAP_POSITION);
                    else
                        s = start_capture(ms, s, p + 1, CAP_UNFINISHED);
                    break;
                }
                case char[')']: {  /* end capture */
                    s = end_capture(ms, s, p + 1);
                    break;
                }
                case char['$']: {
                    if (p + 1 !== ms.p_end) {  /* is the '$' the last char in pattern? */
                        gotodefault = true;  /* no; go to default */
                        break;
                    }
                    s = ms.src.slice(s).length === 0 ? s : null;  /* check end of string */
                    break;
                }
                case L_ESC: {  /* escaped sequences not in the format class[*+?-]? */
                    switch (ms.p[p + 1]) {
                        case char['b']: {  /* balanced string? */
                            s = matchbalance(ms, s, p + 2);
                            if (s !== null) {
                                p = p.slice(4);
                                gotoinit = true;
                            }
                            break;
                        }
                        case char['f']: {
                            p += 2;
                            if (ms.p[p] !== '[')
                                lauxlib.luaL_error(ms.L, lua.to_luastring(`missing '[' after '%f' in pattern`));
                            let ep = classend(ms, p);  /* points to what is next */
                            let previous = s === ms.src_init ? 0 : ms.s[s-1];
                            if (!matchbracketclass(ms, previous, p, ep - 1) && matchbracketclass(ms, ms.src[s], p, ep - 1)) {
                                p = ep; gotoinit = true; break;
                            }
                            s = null;  /* match failed */
                            break;
                        }
                        case char['0']: case char['1']: case char['2']: case char['3']:
                        case char['4']: case char['5']: case char['6']: case char['7']:
                        case char['8']: case char['9']: {  /* capture results (%0-%9)? */
                            s = match_capture(ms, s, ms.p[p + 1]);
                            if (s !== null) {
                                p += 2; gotoinit = true;
                            }
                            break;
                        }
                        default: gotodefault = true;
                    }
                    break;
                }
                default: {  /* pattern class plus optional suffix */
                    gotodefault = false;
                    let ep = classend(ms, p);  /* points to optional suffix */
                    /* does not match at least once? */
                    if (!singlematch(ms, s, p, ep)) {
                        if (ms.p[ep] === char['*'] || ms.p[ep] === char['?'] || ms.p[ep] === char['-']) {  /* accept empty? */
                            p = ep + 1; gotoinit = true; break;
                        } else  /* '+' or no suffix */
                            s = null;  /* fail */
                    } else {  /* matched once */
                        switch (ms.p[ep]) {  /* handle optional suffix */
                            case char['?']: {  /* optional */
                                let res;
                                if ((res = match(ms, s + 1, ep + 1)) !== null)
                                    s = res;
                                else {
                                    p = ep + 1; gotoinit = true;
                                }
                                break;
                            }
                            case char['+']:  /* 1 or more repetitions */
                                s++;  /* 1 match already done */
                            case char['*']:  /* 0 or more repetitions */
                                s = max_expand(ms, s, p, ep);
                                break;
                            case char['-']:  /* 0 or more repetitions (minimum) */
                                s = min_expand(ms, s, p, ep);
                                break;
                            default:  /* no suffix */
                                s++; p = ep; gotoinit = true;
                        }
                    }
                    break;
                }
            }
        }
    }
    ms.matchdepth++;
    return s;
};

const push_onecapture = function(ms, i, s, e) {
    if (i >= ms.level) {
        if (i === 0)
            lapi.lua_pushlstring(ms.L, ms.src.slice(s), e - s);  /* add whole match */
        else
            lauxlib.luaL_error(ms.L, lua.to_luastring(`invalid capture index %${i + 1}`));
    } else {
        let l = ms.capture[i].len;
        if (l === CAP_UNFINISHED) lauxlib.luaL_error(ms.L, lua.to_luastring("unfinished capture", true));
        if (l === CAP_POSITION)
            lapi.lua_pushinteger(ms.L, ms.src_init + 1);
        else
            lapi.lua_pushlstring(ms.L, ms.src.slice(ms.capture[i].init), l);
    }
};

const push_captures = function(ms, s, e) {
    let nlevels = ms.level === 0 && ms.src.slice(s) ? 1 : ms.level;
    lauxlib.luaL_checkstack(ms.L, nlevels, lua.to_luastring("too many catpures", true));
    for (let i = 0; i < nlevels; i++)
        push_onecapture(ms, i, s, e);
    return nlevels;  /* number of strings pushed */
};

const nospecials = function(p, l) {
    let upto = 0;
    do {
        let special = false;
        let supto = p.slice(upto);
        for (let i = 0; i < SPECIALS.length; i++) {
            if (supto.indexOf(SPECIALS[i]) > -1) {
                special = true;
                break;
            }
        }

        if (special)
            return false;  /* pattern has a special character */
        upto = upto + 1;  /* may have more after \0 */
    } while (upto <= l);
    return true;  /* no special chars found */
};

const prepstate = function(ms, L, s, ls, p, lp) {
    ms.L = L;
    ms.matchdepth = MAXCCALLS;
    ms.src = s;
    ms.src_init = 0;
    ms.src_end = ls;
    ms.p = p;
    ms.p_end = lp;
};

const reprepstate = function(ms) {
    ms.level = 0;
    assert(ms.matchdepth === MAXCCALLS);
};

const find_subarray = function(arr, subarr, from_index) {
    var i = from_index >>> 0,
        sl = subarr.length,
        l = arr.length + 1 - sl;

    loop: for (; i < l; i++) {
        for (let j = 0; j < sl; j++)
            if (arr[i+j] !== subarr[j])
                continue loop;
        return i;
    }
    return -1;
};

const str_find_aux = function(L, find) {
    let s = lauxlib.luaL_checkstring(L, 1);
    let p = lauxlib.luaL_checkstring(L, 2);
    let ls = s.length;
    let lp = p.length;
    let init = posrelat(lauxlib.luaL_optinteger(L, 3, 1), ls);
    if (init < 1) init = 1;
    else if (init > ls + 1) {  /* start after string's end? */
        lapi.lua_pushnil(L);  /* cannot find anything */
        return 1;
    }
    /* explicit request or no special characters? */
    if (find && (lapi.lua_toboolean(L, 4) || nospecials(p, lp))) {
        /* do a plain search */
        let f = find_subarray(s.slice(init - 1), p, 0);
        if (f > -1) {
            lapi.lua_pushinteger(L, init + f);
            lapi.lua_pushinteger(L, init + f + lp - 1);
            return 2;
        }
    } else {
        let ms = new MatchState(L);
        let s1 = init - 1;
        let anchor = p[0] === char['^'];
        if (anchor) {
            p = p.slice(1); lp--;  /* skip anchor character */
        }
        prepstate(ms, L, s, ls, p, lp);
        do {
            let res;
            reprepstate(ms);
            if ((res = match(ms, s1, 0)) !== null) {
                if (find) {
                    lapi.lua_pushinteger(L, s1 + 1);  /* start */
                    lapi.lua_pushinteger(L, res);   /* end */
                    return push_captures(ms, null, 0) + 2;
                } else
                    return push_captures(ms, s1, res);
            }
        } while (s1++ < ms.src_end && !anchor);
    }
    lapi.lua_pushnil(L);  /* not found */
    return 1;
};

const str_find = function(L) {
    return str_find_aux(L, 1);
};

const str_match = function(L) {
    return str_find_aux(L, 0);
};

/* state for 'gmatch' */
class GMatchState {
    constructor() {
        this.src = NaN;  /* current position */
        this.p = NaN;  /* pattern */
        this.lastmatch = NaN;  /* end of last match */
        this.ms = new MatchState();  /* match state */
    }
}

const gmatch_aux = function(L) {
    let gm = lapi.lua_touserdata(L, lua.lua_upvalueindex(3));
    gm.ms.L = L;
    for (let src = gm.src; src < gm.ms.src_end; src++) {
        reprepstate(gm.ms);
        let e;
        if ((e = match(gm.ms, src, gm.p)) !== null && e !== gm.lastmatch) {
            gm.src = gm.lastmatch = e;
            return push_captures(gm.ms, src, e);
        }
    }
    return 0;  /* not found */
};

const str_gmatch = function(L) {
    let s = lauxlib.luaL_checkstring(L, 1);
    let p = lauxlib.luaL_checkstring(L, 2);
    let ls = s.length;
    let lp = p.length;
    lapi.lua_settop(L, 2);  /* keep them on closure to avoid being collected */
    let gm = new GMatchState();
    lapi.lua_pushobject(L, gm);
    prepstate(gm.ms, L, s, ls, p, lp);
    gm.src = 0;
    gm.p = 0;
    gm.lastmatch = null;
    lapi.lua_pushcclosure(L, gmatch_aux, 3);
    return 1;
};

const add_s = function(ms, b, s, e) {
    let L = ms.L;
    let news = lapi.lua_tostring(L, 3);
    let l = news.length;
    for (let i = 0; i < l; i++) {
        if (news[i] !== L_ESC)
            lauxlib.luaL_addchar(b, news[i]);
        else {
            i++;  /* skip ESC */
            if (!isdigit(news[i])) {
                if (news[i] !== L_ESC)
                    lauxlib.luaL_error(L, lua.to_luastring(`invalid use of '${sL_ESC}' in replacement string`));
                lauxlib.luaL_addchar(b, news[i]);
            } else if (news[i] === char['0'])
                lauxlib.luaL_addlstring(b, ms.src.slice(s), e - s);
            else {
                push_onecapture(ms, news[i] - char['1'], s, e);
                lauxlib.luaL_tolstring(L, -1);
                lapi.lua_remove(L, -2);  /* remove original value */
                lauxlib.luaL_addvalue(b);  /* add capture to accumulated result */
            }
        }
    }
};

const add_value = function(ms, b, s, e, tr) {
    let L = ms.L;
    switch (tr) {
        case CT.LUA_TFUNCTION: {
            lapi.lua_pushvalue(L, 3);
            let n = push_captures(ms, s, e);
            lapi.lua_call(L, n, 1);
            break;
        }
        case CT.LUA_TTABLE: {
            push_onecapture(ms, 0, s, e);
            lapi.lua_gettable(L, 3);
            break;
        }
        default: {  /* LUA_TNUMBER or LUA_TSTRING */
            add_s(ms, b, s, e);
            return;
        }
    }
    if (!lapi.lua_toboolean(L, -1)) {  /* nil or false? */
        lapi.lua_pop(L, 1);
        lapi.lua_pushlstring(L, s, e - s);  /* keep original text */
    } else if (!lapi.lua_isstring(L, -1))
        lauxlib.luaL_error(L, lua.to_luastring(`invalid replacement value (a ${lobject.jsstring(lauxlib.luaL_typename(L, -1))})`));
        lauxlib.luaL_addvalue(b);  /* add result to accumulator */
};

const str_gsub = function(L) {
    let src = lauxlib.luaL_checkstring(L, 1);  /* subject */
    let srcl = src.length;
    let p = lauxlib.luaL_checkstring(L, 2);  /* pattern */
    let lp = p.length;
    let lastmatch = null;  /* end of last match */
    let tr = lapi.lua_type(L, 3);  /* replacement type */
    let max_s = lauxlib.luaL_optinteger(L, 4, srcl + 1);  /* max replacements */
    let anchor = p[0] === char['^'];
    let n = 0;  /* replacement count */
    let ms = new MatchState(L);
    let b = new lauxlib.luaL_Buffer(L);
    lauxlib.luaL_argcheck(L, tr === CT.LUA_TNUMBER || tr === CT.LUA_TSTRING || tr === CT.LUA_TFUNCTION || tr === CT.LUA_TTABLE, 3,
        lua.to_luastring("string/function/table expected", true));
    lauxlib.luaL_buffinit(L, b);
    if (anchor) {
        p = p.slice(1); lp--;  /* skip anchor character */
    }
    prepstate(ms, L, src, srcl, p, lp);
    src = 0; p = 0;
    while (n < max_s) {
        let e;
        reprepstate(ms);
        if ((e = match(ms, src, p)) !== null && e !== lastmatch) {  /* match? */
            n++;
            add_value(ms, b, src, e, tr);  /* add replacement to buffer */
            src = lastmatch = e;
        } else if (src < ms.src_end)  /* otherwise, skip one character */
            lauxlib.luaL_addchar(b, ms.src[src++]);
        else break;  /* end of subject */
        if (anchor) break;
    }
    lauxlib.luaL_addlstring(b, ms.src.slice(src), ms.src_end - src);
    lauxlib.luaL_pushresult(b);
    lapi.lua_pushinteger(L, n);  /* number of substitutions */
    return 2;
};

const strlib = {
    "byte":     str_byte,
    "char":     str_char,
    "dump":     str_dump,
    "find":     str_find,
    "format":   str_format,
    "gmatch":   str_gmatch,
    "gsub":     str_gsub,
    "len":      str_len,
    "lower":    str_lower,
    "match":    str_match,
    "pack":     str_pack,
    "packsize": str_packsize,
    "rep":      str_rep,
    "reverse":  str_reverse,
    "sub":      str_sub,
    "unpack":   str_unpack,
    "upper":    str_upper
};

const createmetatable = function(L) {
    lapi.lua_createtable(L, 0, 1);  /* table to be metatable for strings */
    lapi.lua_pushliteral(L, "");  /* dummy string */
    lapi.lua_pushvalue(L, -2);  /* copy table */
    lapi.lua_setmetatable(L, -2);  /* set table as metatable for strings */
    lapi.lua_pop(L, 1);  /* pop dummy string */
    lapi.lua_pushvalue(L, -2);  /* get string library */
    lapi.lua_setfield(L, -2, lua.to_luastring("__index", true));  /* lobject.table_index = string */
    lapi.lua_pop(L, 1);  /* pop metatable */  
};

const luaopen_string = function(L) {
    lauxlib.luaL_newlib(L, strlib);
    createmetatable(L);
    return 1;
};

module.exports.luaopen_string = luaopen_string;
