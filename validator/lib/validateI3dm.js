'use strict';
var Cesium = require('cesium');
var bufferToJson = require('../lib/bufferToJson');
var utility = require('../lib/utility');
var validateBatchTable = require('../lib/validateBatchTable');
var validateFeatureTable = require('../lib/validateFeatureTable');
var validateGlb = require('../lib/validateGlb');

var batchTableSchema = require('../specs/data/schema/batchTable.schema.json');
var featureTableSchema = require('../specs/data/schema/featureTable.schema.json');

var isBufferValidUtf8 = utility.isBufferValidUtf8;

var defaultValue = Cesium.defaultValue;
var defined = Cesium.defined;
var Cartesian3 = Cesium.Cartesian3;
var Cesium3DTileFeatureTable = Cesium.Cesium3DTileFeatureTable;
var ComponentDatatype = Cesium.ComponentDatatype;
var octDecodeWithoutNormalization = utility.octDecodeWithoutNormalization;

module.exports = validateI3dm;

var featureTableSemantics = {
    POSITION : {
        global : false,
        type : 'VEC3',
        componentType : 'FLOAT'
    },
    POSITION_QUANTIZED : {
        global : false,
        type : 'VEC3',
        componentType : 'UNSIGNED_SHORT'
    },
    NORMAL_UP : {
        global : false,
        type : 'VEC3',
        componentType : 'FLOAT'
    },
    NORMAL_RIGHT : {
        global : false,
        type : 'VEC3',
        componentType : 'FLOAT'
    },
    NORMAL_UP_OCT32P : {
        global : false,
        type : 'VEC2',
        componentType : 'UNSIGNED_SHORT'
    },
    NORMAL_RIGHT_OCT32P : {
        global : false,
        type : 'VEC2',
        componentType : 'UNSIGNED_SHORT'
    },
    SCALE : {
        global : false,
        type : 'SCALAR',
        componentType : 'FLOAT'
    },
    SCALE_NON_UNIFORM : {
        global : false,
        type : 'VEC3',
        componentType : 'FLOAT'
    },
    BATCH_ID : {
        global : false,
        type : 'SCALAR',
        componentType : 'UNSIGNED_SHORT',
        componentTypeOptions : ['UNSIGNED_BYTE', 'UNSIGNED_SHORT', 'UNSIGNED_INT']
    },
    INSTANCES_LENGTH : {
        global : true,
        type : 'SCALAR',
        componentType : 'UNSIGNED_INT'
    },
    RTC_CENTER : {
        global : true,
        type : 'VEC3',
        componentType : 'FLOAT'
    },
    QUANTIZED_VOLUME_OFFSET : {
        global : true,
        type : 'VEC3',
        componentType : 'FLOAT'
    },
    QUANTIZED_VOLUME_SCALE : {
        global : true,
        type : 'VEC3',
        componentType : 'FLOAT'
    },
    EAST_NORTH_UP : {
        global : true,
        type : 'boolean'
    }
};

/**
 * Checks if the provided buffer has valid i3dm tile content.
 *
 * @param {Buffer} content A buffer containing the contents of an i3dm tile.
 * @returns {String} An error message if validation fails, otherwise undefined.
 */
function validateI3dm(content) {
    var headerByteLength = 32;
    if (content.length < headerByteLength) {
        return 'Header must be 32 bytes.';
    }

    var magic = content.toString('utf8', 0, 4);
    var version = content.readUInt32LE(4);
    var byteLength = content.readUInt32LE(8);
    var featureTableJsonByteLength = content.readUInt32LE(12);
    var featureTableBinaryByteLength = content.readUInt32LE(16);
    var batchTableJsonByteLength = content.readUInt32LE(20);
    var batchTableBinaryByteLength = content.readUInt32LE(24);
    var gltfFormat = content.readUInt32LE(28);

    if (magic !== 'i3dm') {
        return 'Invalid magic: ' + magic;
    }

    if (version !== 1) {
        return 'Invalid version: ' + version + '. Version must be 1.';
    }

    if (byteLength !== content.length) {
        return 'byteLength of ' + byteLength + ' does not equal the tile\'s actual byte length of ' + content.length + '.';
    }

    if (gltfFormat > 1) {
        return 'invalid gltfFormat "' + gltfFormat + '". Must be 0 or 1.';
    }

    var featureTableJsonByteOffset = headerByteLength;
    var featureTableBinaryByteOffset = featureTableJsonByteOffset + featureTableJsonByteLength;
    var batchTableJsonByteOffset = featureTableBinaryByteOffset + featureTableBinaryByteLength;
    var batchTableBinaryByteOffset = batchTableJsonByteOffset + batchTableJsonByteLength;
    var glbByteOffset = batchTableBinaryByteOffset + batchTableBinaryByteLength;
    var glbByteLength = Math.max(byteLength - glbByteOffset, 0);

    if (featureTableBinaryByteOffset % 8 > 0) {
        return 'Feature table binary must be aligned to an 8-byte boundary.';
    }

    if (batchTableBinaryByteOffset % 8 > 0) {
        return 'Batch table binary must be aligned to an 8-byte boundary.';
    }

    var embeddedGlb = (gltfFormat === 1);
    if (embeddedGlb && glbByteOffset % 8 > 0) {
        return 'Glb must be aligned to an 8-byte boundary.';
    }

    if (headerByteLength + featureTableJsonByteLength + featureTableBinaryByteLength + batchTableJsonByteLength + batchTableBinaryByteLength + glbByteLength > byteLength) {
        return 'Feature table, batch table, and glb byte lengths exceed the tile\'s byte length.';
    }

    var featureTableJsonBuffer = content.slice(featureTableJsonByteOffset, featureTableBinaryByteOffset);
    var featureTableBinary = content.slice(featureTableBinaryByteOffset, batchTableJsonByteOffset);
    var batchTableJsonBuffer = content.slice(batchTableJsonByteOffset, batchTableBinaryByteOffset);
    var batchTableBinary = content.slice(batchTableBinaryByteOffset, glbByteOffset);
    var glbBuffer = content.slice(glbByteOffset, byteLength);

    var featureTableJson;
    var batchTableJson;

    try {
        featureTableJson = bufferToJson(featureTableJsonBuffer);
    } catch(error) {
        return 'Feature table JSON could not be parsed: ' + error.message;
    }

    try {
        batchTableJson = bufferToJson(batchTableJsonBuffer);
    } catch(error) {
        return 'Batch table JSON could not be parsed: ' + error.message;
    }

    var featuresLength = featureTableJson.INSTANCES_LENGTH;
    if (!defined(featuresLength)) {
        return 'Feature table must contain an INSTANCES_LENGTH property.';
    }

    if (!defined(featureTableJson.POSITION) && !defined(featureTableJson.POSITION_QUANTIZED)) {
        return 'Feature table must contain either the POSITION or POSITION_QUANTIZED property.';
    }

    if (defined(featureTableJson.NORMAL_UP) && !defined(featureTableJson.NORMAL_RIGHT)) {
        return 'Feature table property NORMAL_RIGHT is required when NORMAL_UP is present.';
    }

    if (!defined(featureTableJson.NORMAL_UP) && defined(featureTableJson.NORMAL_RIGHT)) {
        return 'Feature table property NORMAL_UP is required when NORMAL_RIGHT is present.';
    }

    if (defined(featureTableJson.NORMAL_UP_OCT32P) && !defined(featureTableJson.NORMAL_RIGHT_OCT32P)) {
        return 'Feature table property NORMAL_RIGHT_OCT32P is required when NORMAL_UP_OCT32P is present.';
    }

    if (!defined(featureTableJson.NORMAL_UP_OCT32P) && defined(featureTableJson.NORMAL_RIGHT_OCT32P)) {
        return 'Feature table property NORMAL_UP_OCT32P is required when NORMAL_RIGHT_OCT32P is present.';
    }

    if (defined(featureTableJson.POSITION_QUANTIZED) && (!defined(featureTableJson.QUANTIZED_VOLUME_OFFSET) || !defined(featureTableJson.QUANTIZED_VOLUME_SCALE))) {
        return 'Feature table properties QUANTIZED_VOLUME_OFFSET and QUANTIZED_VOLUME_SCALE are required when POSITION_QUANTIZED is present.';
    }

    var featureTable = new Cesium3DTileFeatureTable(featureTableJson, featureTableBinary);
    var normalUpArray, normalRightArray;
    var octUp = false;
    var octRight = false;
    var componentDatatype;
    var i;

    if (defined(featureTableJson.NORMAL_UP)) {
        featureTable.featuresLength = featuresLength;
        componentDatatype = ComponentDatatype.fromName(defaultValue(featureTableJson.NORMAL_UP.componentType, 'FLOAT'));
        normalUpArray = featureTable.getPropertyArray('NORMAL_UP', componentDatatype, 3);
    } else if (defined(featureTableJson.NORMAL_UP_OCT32P)) {
        octUp = true;
        featureTable.featuresLength = featuresLength;
        componentDatatype = ComponentDatatype.fromName(defaultValue(featureTableJson.NORMAL_UP_OCT32P.componentType, 'UNSIGNED_SHORT'));
        normalUpArray = featureTable.getPropertyArray('NORMAL_UP_OCT32P', componentDatatype, 2);
    }

    if (defined(featureTableJson.NORMAL_RIGHT)) {
        featureTable.featuresLength = featuresLength;
        componentDatatype = ComponentDatatype.fromName(defaultValue(featureTableJson.NORMAL_RIGHT.componentType, 'FLOAT'));
        normalRightArray = featureTable.getPropertyArray('NORMAL_RIGHT', componentDatatype, 3);
    } else if (defined(featureTableJson.NORMAL_RIGHT_OCT32P)) {
        octRight = true;
        featureTable.featuresLength = featuresLength;
        componentDatatype = ComponentDatatype.fromName(defaultValue(featureTableJson.NORMAL_RIGHT_OCT32P.componentType, 'UNSIGNED_SHORT'));
        normalRightArray = featureTable.getPropertyArray('NORMAL_RIGHT_OCT32P', componentDatatype, 2);
    }

    var normalUp = new Cartesian3();
    var normalRight = new Cartesian3();
    if (defined(normalUpArray) && defined(normalRightArray)) {
        for (i = 0; i < featuresLength; i++) {
            if (octUp) {
                octDecodeWithoutNormalization(normalUpArray[i*2], normalUpArray[i*2+1], 65535, normalUp);
            } else {
                Cartesian3.unpack(normalUpArray, i*3, normalUp);
            }
            if (octRight) {
                octDecodeWithoutNormalization(normalRightArray[i*2], normalRightArray[i*2+1], 65535, normalRight);
            } else {
                Cartesian3.unpack(normalRightArray, i*3, normalRight);
            }

            var normalUpMagnitude = Cartesian3.magnitude(normalUp);
            if (Math.abs(normalUpMagnitude - 1.0) > Cesium.Math.EPSILON2) {
                if (octUp) {
                    return 'normal defined in NORMAL_UP_OCT32P must be of length 1.0';
                }
                return 'normal defined in NORMAL_UP must be of length 1.0';
            }
            var normalRightMagnitude = Cartesian3.magnitude(normalRight);
            if (Math.abs(normalRightMagnitude - 1.0) > Cesium.Math.EPSILON2) {
                if (octRight) {
                    return 'normal defined in NORMAL_RIGHT_OCT32P must be of length 1.0';
                }
                return 'normal defined in NORMAL_RIGHT must be of length 1.0';
            }

            var dotProd = Cartesian3.dot(normalUp,normalRight);
            if (Math.abs(dotProd) > Cesium.Math.EPSILON4) {
                return 'up and right normals must be mutually orthogonal';
            }
        }
    }

    var featureTableMessage = validateFeatureTable(featureTableSchema, featureTableJson, featureTableBinary, featuresLength, featureTableSemantics);
    if (defined(featureTableMessage)) {
        return featureTableMessage;
    }

    var batchTableMessage = validateBatchTable(batchTableSchema, batchTableJson, batchTableBinary, featuresLength);
    if (defined(batchTableMessage)) {
        return batchTableMessage;
    }

    if (embeddedGlb) {
        var glbMessage = validateGlb(glbBuffer);
        if (defined(glbMessage)) {
            return glbMessage;
        }
    } else if (!isBufferValidUtf8(glbBuffer)) {
        return 'Gltf url is not a valid utf-8 string';
    }
}
