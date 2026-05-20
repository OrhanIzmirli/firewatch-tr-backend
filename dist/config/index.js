"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisClient = exports.pool = void 0;
const database_1 = __importDefault(require("./database"));
exports.pool = database_1.default;
const redis_1 = __importDefault(require("./redis"));
exports.redisClient = redis_1.default;
