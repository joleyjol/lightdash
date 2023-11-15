import {
    CreateStarrocksCredentials,
    ParseError,
    WarehouseTypes,
} from '@lightdash/common';
import { JSONSchemaType } from 'ajv';
import betterAjvErrors from 'better-ajv-errors';
import { ajv } from '../../ajv';
import { Target } from '../types';

export type StarrocksTarget = {
    type: 'starrocks';
    host: string;
    user?: string;
    username?: string;
    port: number;
    dbname?: string;
    database?: string;
    schema: string;
    threads: number;
    pass?: string;
    password?: string;
    keepalives_idle?: number;
    connect_timeout?: number;
    search_path?: string;
    role?: string;
    sslmode?: string;
};

export const starrocksSchema: JSONSchemaType<StarrocksTarget> = {
    type: 'object',
    properties: {
        type: {
            type: 'string',
            enum: ['starrocks'],
        },
        host: {
            type: 'string',
        },
        user: {
            type: 'string',
            nullable: true,
        },
        username: {
            type: 'string',
            nullable: true,
        },
        port: {
            type: 'integer',
        },
        dbname: {
            type: 'string',
            nullable: true,
        },
        database: {
            type: 'string',
            nullable: true,
        },
        schema: {
            type: 'string',
        },
        threads: {
            type: 'integer',
            nullable: true,
        },
        pass: {
            type: 'string',
            nullable: true,
        },
        password: {
            type: 'string',
            nullable: true,
        },
        keepalives_idle: {
            type: 'integer',
            nullable: true,
        },
        connect_timeout: {
            type: 'integer',
            nullable: true,
        },
        search_path: {
            type: 'string',
            nullable: true,
        },
        role: {
            type: 'string',
            nullable: true,
        },
        sslmode: {
            type: 'string',
            nullable: true,
        },
    },
    required: ['type', 'host', 'port', 'schema'],
};

export const convertStarrocksSchema = (
    target: Target,
): CreateStarrocksCredentials => {
    const validate = ajv.compile<StarrocksTarget>(starrocksSchema);
        const user = target.user || target.username;
        if (!user) {
            throw new ParseError(
                `Starrocks target requires a username: "username"`,
            );
        }
    if (validate(target)) {
        const password = target.pass || target.password;
        if (!password) {
            throw new ParseError(
                `Starrocks target requires a password: "password"`,
            );
        }
        const dbname = target.dbname || target.database;
        return {
            type: WarehouseTypes.STARROCKS,
            host: target.host,
            user,
            password,
            port: target.port,
            schema: target.schema,
        };
    }
    const errs = betterAjvErrors(starrocksSchema, target, validate.errors || []);
    throw new ParseError(
        `Couldn't read profiles.yml file for ${target.type}:\n${errs}`,
    );
};
