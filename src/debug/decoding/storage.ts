import { Address, keccak256 } from "ethereumjs-util";
import {
    AddressType,
    ArrayType,
    assert,
    BoolType,
    BytesType,
    ContractDefinition,
    DataLocation as SolDataLocation,
    EnumDefinition,
    enumToIntType,
    FixedBytesType,
    InferType,
    IntType,
    MappingType,
    PointerType,
    StringType,
    StructDefinition,
    TypeNode,
    UserDefinedType,
    UserDefinedValueTypeDefinition
} from "solc-typed-ast";
import { changeToLocation, Storage, StorageLocation } from "..";
import { bigEndianBufToBigint, bigIntToBuf, fits, MAX_ARR_DECODE_LIMIT, uint256 } from "../..";

/**
 * Helper to fetch the word residing at key `key` from `storage`.  Note that
 * this always succeeds as all uninitialized values in storage are defined to
 * contain 0.
 */
function fetchWord(key: bigint, storage: Storage): Buffer {
    const keyHash = bigEndianBufToBigint(keccak256(bigIntToBuf(key, 32, "big")));
    const res = storage.get(keyHash);

    if (res === undefined) {
        return Buffer.alloc(32, 0);
    }

    return res;
}

/**
 * Helper to fetch `numBytes` bytes from `storage` starting at offset `off`.
 * Note that this always succeeds as all uninitialized values in storage are
 * defined to contain 0.
 */
function fetchBytes(
    wordOff: bigint,
    offInWord: number,
    numBytes: number,
    storage: Storage
): Buffer {
    let curBuf = fetchWord(wordOff, storage);
    const res = Buffer.alloc(numBytes, 0);

    for (let i = 0; i < numBytes; i++) {
        res[i] = curBuf[offInWord];

        offInWord = (offInWord + 1) % 32;

        if (offInWord === 0 && i < numBytes - 1) {
            wordOff++;

            curBuf = fetchWord(wordOff, storage);
        }
    }

    return res;
}

/**
 * Decode a single integer of type `typ` from location `loc` in `storage`.
 * Returns pair `[bigint, number]` containing the decoded number and its size
 * in bytes in storage. Note: Always succeed as we can decode a valid integer
 * in any location in storage.
 */
function stor_decodeInt(
    typ: IntType,
    loc: StorageLocation,
    storage: Storage
): [bigint, StorageLocation] {
    const size = typ.nBits / 8;

    assert(
        loc.endOffsetInWord >= size,
        `Internal Error: Can't decode {0} starting at offset {1} in word {2}`,
        typ,
        loc.endOffsetInWord,
        loc.address
    );

    const rawBytes = fetchBytes(loc.address, loc.endOffsetInWord - size, size, storage);

    let res = bigEndianBufToBigint(rawBytes);
    //console.error(`stor_decodeInt rawBytes=${rawBytes.toString(`hex`)} res=${res}`);

    // Convert signed negative 2's complement values
    if (typ.signed && (res & (BigInt(1) << BigInt(typ.nBits - 1))) !== BigInt(0)) {
        // Mask out any 1's above the number's size
        res = res & ((BigInt(1) << BigInt(typ.nBits)) - BigInt(1));
        res = -((BigInt(1) << BigInt(typ.nBits)) - res);
    }

    assert(
        fits(res, typ),
        `Decoded value ${res} from ${loc} doesn't fit in expected type ${typ.pp()}`
    );

    const nextEndOff = loc.endOffsetInWord - size;

    const nextLoc: StorageLocation = {
        kind: loc.kind,
        endOffsetInWord: nextEndOff === 0 ? 32 : nextEndOff,
        address: nextEndOff === 0 ? loc.address + BigInt(1) : loc.address
    };

    return [res, nextLoc];
}

const byte1 = new IntType(8, false);

/**
 * Decode a boolean from the given location in storage
 */
function stor_decodeBool(
    loc: StorageLocation,
    storage: Storage
): undefined | [boolean, StorageLocation] {
    const [val, nextLoc] = stor_decodeInt(byte1, loc, storage);

    return [val !== BigInt(0), nextLoc];
}

/**
 * Decode an enum value from storage
 */
function stor_decodeEnum(
    def: EnumDefinition,
    loc: StorageLocation,
    storage: Storage
): undefined | [bigint, StorageLocation] {
    const typ = enumToIntType(def);

    return stor_decodeInt(typ, loc, storage);
}

/**
 * Decode a boolean from the given location in storage
 */
function stor_decodeFixedBytes(
    typ: FixedBytesType,
    loc: StorageLocation,
    storage: Storage
): undefined | [Buffer, StorageLocation] {
    assert(
        loc.endOffsetInWord >= typ.size,
        `Internal Error: Can't decode {0} starting at offset {1} in word {2}`,
        typ,
        loc.endOffsetInWord,
        loc.address
    );

    const bytes = fetchBytes(loc.address, loc.endOffsetInWord - typ.size, typ.size, storage);

    const nextEndOff = loc.endOffsetInWord - typ.size;
    const nextLoc: StorageLocation = {
        kind: loc.kind,
        endOffsetInWord: nextEndOff === 0 ? 32 : nextEndOff,
        address: nextEndOff === 0 ? loc.address + BigInt(1) : loc.address
    };

    return [bytes, nextLoc];
}

/**
 * Decode a boolean from the given location in storage
 */
function stor_decodeAddress(
    loc: StorageLocation,
    storage: Storage
): undefined | [Address, StorageLocation] {
    assert(
        loc.endOffsetInWord >= 20,
        `Internal Error: Can't decode address starting at offset {0} in word {1}`,
        loc.endOffsetInWord,
        loc.address
    );

    const bytes = fetchBytes(loc.address, loc.endOffsetInWord - 20, 20, storage);
    const nextEndOff = loc.endOffsetInWord - 20;
    const nextLoc: StorageLocation = {
        kind: loc.kind,
        endOffsetInWord: nextEndOff === 0 ? 32 : nextEndOff,
        address: nextEndOff === 0 ? loc.address + BigInt(1) : loc.address
    };

    return [new Address(bytes), nextLoc];
}

/**
 * Compute the 'static' size that a variable of type `typ` would take up in storage
 */
function typeStaticStorSize(typ: TypeNode, infer: InferType): number {
    if (typ instanceof IntType) {
        return typ.nBits / 8;
    }

    if (typ instanceof FixedBytesType) {
        return typ.size;
    }

    if (typ instanceof BoolType) {
        return 1;
    }

    if (typ instanceof AddressType) {
        return 20;
    }

    if (typ instanceof UserDefinedType) {
        if (typ.definition instanceof EnumDefinition) {
            return enumToIntType(typ.definition).nBits / 8;
        }

        if (typ.definition instanceof UserDefinedValueTypeDefinition) {
            return typeStaticStorSize(
                infer.typeNameToTypeNode(typ.definition.underlyingType),
                infer
            );
        }
    }

    throw new Error(`NYI typStaticStorSize(${typ.pp()})`);
}

function typeFitsInLoc(typ: TypeNode, loc: StorageLocation, infer: InferType): boolean {
    if (typ instanceof PointerType) {
        if (
            typ.to instanceof ArrayType ||
            typ.to instanceof BytesType ||
            typ.to instanceof StringType ||
            (typ.to instanceof UserDefinedType && typ.to.definition instanceof StructDefinition) ||
            typ.to instanceof MappingType
        ) {
            return loc.endOffsetInWord === 32;
        }

        throw new Error(`NYI firstLocationOfTypeAfter(${typ.pp()},...)`);
    }

    const size = typeStaticStorSize(typ, infer);

    assert(size <= 32, `Unexpected type ${typ.pp()} spanning more than a single word`);

    return size <= loc.endOffsetInWord;
}

function nextWord(loc: StorageLocation): StorageLocation {
    return {
        kind: loc.kind,
        endOffsetInWord: 32,
        address: loc.address + BigInt(1)
    };
}

function roundLocToType(loc: StorageLocation, typ: TypeNode, infer: InferType): StorageLocation {
    if (typeFitsInLoc(typ, loc, infer)) {
        return loc;
    }

    return nextWord(loc);
}

/**
 * Decode a struct of type `typ` from location `loc` in `storage`.
 * Returns undefined when it fails decoding, otherwise a pair `[any, number]`
 * containing an object with the decoded fields and its size in bytes in storage.
 */
function stor_decodeStruct(
    typ: UserDefinedType,
    loc: StorageLocation,
    storage: Storage,
    infer: InferType
): undefined | [any, StorageLocation] {
    const def = typ.definition;

    assert(def instanceof StructDefinition, `stor_decodeStruct expects a struct, not {0}`, typ);
    assert(
        loc.endOffsetInWord === 32,
        `Internal Error: Location of struct of type {0} doesn't start at the end of word {1} - instead at off {2}`,
        typ,
        loc.address,
        loc.endOffsetInWord
    );

    const res: any = {};

    for (const field of def.vMembers) {
        let fieldGenT: TypeNode;

        try {
            fieldGenT = infer.variableDeclarationToTypeNode(field);
        } catch (e) {
            return undefined;
        }

        const fieldT = changeToLocation(fieldGenT, SolDataLocation.Storage);

        loc = roundLocToType(loc, fieldT, infer);

        const fieldVal = stor_decodeValue(fieldT, loc, storage, infer);

        if (fieldVal === undefined) {
            return undefined;
        }

        [res[field.name], loc] = fieldVal;
    }

    return [res, loc];
}

function keccakOfAddr(addr: bigint): bigint {
    const addrBuf = bigIntToBuf(addr, 32, "big");
    const hashBuf = keccak256(addrBuf);

    return bigEndianBufToBigint(hashBuf);
}

function stor_decodeBytes(
    loc: StorageLocation,
    storage: Storage
): undefined | [Buffer, StorageLocation] {
    assert(
        loc.endOffsetInWord === 32,
        `Internal Error: Decoding bytes in the middle (off {0}) of word {1}`,
        loc.endOffsetInWord,
        loc.address
    );

    const word = fetchWord(loc.address, storage);
    const lByte = word[31];

    if (lByte % 2 === 0) {
        /// Less than 31 bytes - length * 2 stored in lowest byte
        const len = lByte / 2;
        assert(len <= 31, `Unexpected length of more than 31`);

        return [word.slice(0, len), nextWord(loc)];
    }

    let [len] = stor_decodeInt(uint256, loc, storage);

    len = (len - BigInt(1)) / BigInt(2);

    if (len > MAX_ARR_DECODE_LIMIT) {
        return undefined;
    }

    const numLen = Number(len);
    const addr = keccakOfAddr(loc.address);

    const res = fetchBytes(addr, 0, numLen, storage);

    return [res, nextWord(loc)];
}

function stor_decodeString(
    loc: StorageLocation,
    storage: Storage
): undefined | [string, StorageLocation] {
    const res = stor_decodeBytes(loc, storage);

    if (res === undefined) {
        return undefined;
    }

    const str = res[0].toString("utf-8");

    return [str, res[1]];
}

function stor_decodeArray(
    typ: ArrayType,
    loc: StorageLocation,
    storage: Storage,
    infer: InferType
): undefined | [any[], StorageLocation] {
    let numLen: number;
    let contentsLoc: StorageLocation;

    const res: any[] = [];

    if (typ.size === undefined) {
        const [len] = stor_decodeInt(uint256, loc, storage);

        //console.error(`stor_decodeArray: Decoded len ${len} at loc ${ppLoc(loc)}`);
        if (len > MAX_ARR_DECODE_LIMIT) {
            return undefined;
        }

        numLen = Number(len);

        contentsLoc = {
            kind: loc.kind,
            address: keccakOfAddr(loc.address),
            endOffsetInWord: 32
        };
    } else {
        if (typ.size > MAX_ARR_DECODE_LIMIT) {
            return undefined;
        }

        numLen = Number(typ.size);

        contentsLoc = loc;
    }

    for (let i = 0; i < numLen; i++) {
        const elRes = stor_decodeValue(typ.elementT, contentsLoc, storage, infer);

        if (elRes === undefined) {
            return undefined;
        }

        res.push(elRes[0]);

        contentsLoc = roundLocToType(elRes[1], typ.elementT, infer);
    }

    return [res, nextWord(loc)];
}

/**
 * Decode a pointer of type `typ` from location `loc` in `storage`.
 * Returns undefined when it fails decoding, otherwise a pair `[any, number]`
 * containing the decoded value and its size in bytes in storage.
 *
 * Pointers are a little tricky in storage, as you never really store pointers in storage.
 * Instead the 'pointed to' location is computed depending on the type, and some data or empty values may live
 * at the actual poitner location. Here are the possible cases:
 *
 * 1. Pointer to array - the length of the array is stored at the pointer location, the actual array lives at keccak256(loc.address)
 * 2. Pointer to fixed sized array - TODO????
 * 3. Pointer to bytes/string - if shorter than 32 bytes, 2*len is stored in the lowest byte of loc.address and the string/bytes in the upper 31 bytes
 *  Otherwise 2*len+1 is stored at loc.address (TODO little endian? big endian encoded?) and the contents are at keccak256(loc.address)
 * 3. Pointer to struct - the struct fields themselves directly starts at the loc.address
 */
function stor_decodePointer(
    typ: PointerType,
    loc: StorageLocation,
    storage: Storage,
    infer: InferType
): undefined | [any, StorageLocation] {
    if (typ.to instanceof BytesType) {
        return stor_decodeBytes(loc, storage);
    }

    if (typ.to instanceof StringType) {
        return stor_decodeString(loc, storage);
    }

    if (typ.to instanceof UserDefinedType) {
        if (typ.to.definition instanceof StructDefinition) {
            return stor_decodeStruct(typ.to, loc, storage, infer);
        }
    }

    if (typ.to instanceof ArrayType) {
        return stor_decodeArray(typ.to, loc, storage, infer);
    }

    throw new Error(`NYI stor_decodePointer(${typ.pp()},...)`);
}

export function stor_decodeValue(
    typ: TypeNode,
    loc: StorageLocation,
    storage: Storage,
    infer: InferType
): undefined | [any, StorageLocation] {
    if (typ instanceof IntType) {
        return stor_decodeInt(typ, loc, storage);
    }

    if (typ instanceof BoolType) {
        return stor_decodeBool(loc, storage);
    }

    if (typ instanceof FixedBytesType) {
        return stor_decodeFixedBytes(typ, loc, storage);
    }

    if (typ instanceof AddressType) {
        return stor_decodeAddress(loc, storage);
    }

    if (typ instanceof PointerType) {
        return stor_decodePointer(typ, loc, storage, infer);
    }

    if (typ instanceof BytesType) {
        return stor_decodeBytes(loc, storage);
    }

    if (typ instanceof StringType) {
        return stor_decodeString(loc, storage);
    }

    if (typ instanceof ArrayType) {
        return stor_decodeArray(typ, loc, storage, infer);
    }

    if (typ instanceof UserDefinedType) {
        if (typ.definition instanceof StructDefinition) {
            return stor_decodeStruct(typ, loc, storage, infer);
        }

        if (typ.definition instanceof ContractDefinition) {
            return stor_decodeAddress(loc, storage);
        }

        if (typ.definition instanceof EnumDefinition) {
            return stor_decodeEnum(typ.definition, loc, storage);
        }

        if (typ.definition instanceof UserDefinedValueTypeDefinition) {
            const underlyingType = infer.typeNameToTypeNode(typ.definition.underlyingType);

            return stor_decodeValue(underlyingType, loc, storage, infer);
        }
    }

    throw new Error(`NYI storage decode for type ${typ.pp()}`);
}
