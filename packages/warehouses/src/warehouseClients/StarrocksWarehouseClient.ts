import {
    CreateStarrocksCredentials,
    DimensionType,
    Metric,
    MetricType,
    SupportedDbtAdapter,
    WarehouseQueryError,
} from '@lightdash/common';
import { readFileSync } from 'fs';
import path from 'path';
import * as pg from 'pg';
import { PoolConfig, QueryResult } from 'pg';
import { Writable } from 'stream';
import { rootCertificates } from 'tls';
import QueryStream from './PgQueryStream';
import WarehouseBaseClient from './WarehouseBaseClient';

const STARROCKS_CA_BUNDLES = [
    ...rootCertificates,
    readFileSync(path.resolve(__dirname, './ca-bundle-aws-rds-global.pem')),
];

export enum StarrocksTypes {
    INTEGER = 'integer',
    INT = 'int',
    INT2 = 'int2',
    INT4 = 'int4',
    INT8 = 'int8',
    MONEY = 'money',
    SMALLSERIAL = 'smallserial',
    SERIAL = 'serial',
    SERIAL2 = 'serial2',
    SERIAL4 = 'serial4',
    SERIAL8 = 'serial8',
    BIGSERIAL = 'bigserial',
    BIGINT = 'bigint',
    SMALLINT = 'smallint',
    BOOLEAN = 'boolean',
    BOOL = 'bool',
    DATE = 'date',
    DOUBLE_PRECISION = 'double precision',
    FLOAT = 'float',
    FLOAT4 = 'float4',
    FLOAT8 = 'float8',
    JSON = 'json',
    JSONB = 'jsonb',
    NUMERIC = 'numeric',
    DECIMAL = 'decimal',
    REAL = 'real',
    CHAR = 'char',
    CHARACTER = 'character',
    NCHAR = 'nchar',
    BPCHAR = 'bpchar',
    VARCHAR = 'varchar',
    CHARACTER_VARYING = 'character varying',
    NVARCHAR = 'nvarchar',
    TEXT = 'text',
    TIME = 'time',
    TIME_TZ = 'timetz',
    TIME_WITHOUT_TIME_ZONE = 'time without time zone',
    TIMESTAMP = 'timestamp',
    TIMESTAMP_TZ = 'timestamptz',
    TIMESTAMP_WITHOUT_TIME_ZONE = 'timestamp without time zone',
}

const mapFieldType = (type: string): DimensionType => {
    switch (type) {
        case StarrocksTypes.DECIMAL:
        case StarrocksTypes.NUMERIC:
        case StarrocksTypes.INTEGER:
        case StarrocksTypes.MONEY:
        case StarrocksTypes.SMALLSERIAL:
        case StarrocksTypes.SERIAL:
        case StarrocksTypes.SERIAL2:
        case StarrocksTypes.SERIAL4:
        case StarrocksTypes.SERIAL8:
        case StarrocksTypes.BIGSERIAL:
        case StarrocksTypes.INT2:
        case StarrocksTypes.INT4:
        case StarrocksTypes.INT8:
        case StarrocksTypes.BIGINT:
        case StarrocksTypes.SMALLINT:
        case StarrocksTypes.FLOAT:
        case StarrocksTypes.FLOAT4:
        case StarrocksTypes.FLOAT8:
        case StarrocksTypes.DOUBLE_PRECISION:
        case StarrocksTypes.REAL:
            return DimensionType.NUMBER;
        case StarrocksTypes.DATE:
            return DimensionType.DATE;
        case StarrocksTypes.TIME:
        case StarrocksTypes.TIME_TZ:
        case StarrocksTypes.TIMESTAMP:
        case StarrocksTypes.TIMESTAMP_TZ:
        case StarrocksTypes.TIME_WITHOUT_TIME_ZONE:
        case StarrocksTypes.TIMESTAMP_WITHOUT_TIME_ZONE:
            return DimensionType.TIMESTAMP;
        case StarrocksTypes.BOOLEAN:
        case StarrocksTypes.BOOL:
            return DimensionType.BOOLEAN;
        default:
            return DimensionType.STRING;
    }
};

const { builtins } = pg.types;
const convertDataTypeIdToDimensionType = (
    dataTypeId: number,
): DimensionType => {
    switch (dataTypeId) {
        case builtins.NUMERIC:
        case builtins.MONEY:
        case builtins.INT2:
        case builtins.INT4:
        case builtins.INT8:
        case builtins.FLOAT4:
        case builtins.FLOAT8:
            return DimensionType.NUMBER;
        case builtins.DATE:
            return DimensionType.DATE;
        case builtins.TIME:
        case builtins.TIMETZ:
        case builtins.TIMESTAMP:
        case builtins.TIMESTAMPTZ:
            return DimensionType.TIMESTAMP;
        case builtins.BOOL:
            return DimensionType.BOOLEAN;
        default:
            return DimensionType.STRING;
    }
};

export class StarrocksClient<
    T extends CreateStarrocksCredentials,
> extends WarehouseBaseClient<T> {
    config: pg.PoolConfig;

    constructor(credentials: T, config: pg.PoolConfig) {
        super(credentials);
        this.config = config;
    }

    private getSQLWithMetadata(sql: string, tags?: Record<string, string>) {
        let alteredQuery = sql;
        if (tags) {
            alteredQuery = `${alteredQuery}\n-- ${JSON.stringify(tags)}`;
        }
        return alteredQuery;
    }

    private convertQueryResultFields(
        fields: QueryResult<any>['fields'],
    ): Record<string, { type: DimensionType }> {
        return fields.reduce(
            (acc, { name, dataTypeID }) => ({
                ...acc,
                [name]: {
                    type: convertDataTypeIdToDimensionType(dataTypeID),
                },
            }),
            {},
        );
    }

    async runQuery(sql: string, tags?: Record<string, string>) {
        let pool: pg.Pool | undefined;
        return new Promise<{
            fields: Record<string, { type: DimensionType }>;
            rows: Record<string, any>[];
        }>((resolve, reject) => {
            pool = new pg.Pool({
                ...this.config,
                connectionTimeoutMillis: 5000,
            });

            pool.on('error', (err) => {
                console.error(`Starrocks pool error ${err.message}`);
                reject(err);
            });

            pool.on('connect', (_client: pg.PoolClient) => {
                // On each new client initiated, need to register for error(this is a serious bug on pg, the client throw errors although it should not)
                _client.on('error', (err: Error) => {
                    console.error(
                        `Starrocks client connect error ${err.message}`,
                    );
                    reject(err);
                });
            });
            pool.connect((err, client, done) => {
                if (err) {
                    reject(err);
                    done();
                    return;
                }
                if (!client) {
                    reject(new Error('client undefined'));
                    done();
                    return;
                }

                client.on('error', (e) => {
                    console.error(`Starrocks client error ${e.message}`);
                    reject(e);
                    done();
                });

                // CodeQL: This will raise a security warning because user defined raw SQL is being passed into the database module.
                //         In this case this is exactly what we want to do. We're hitting the user's warehouse not the application's database.
                const stream = client.query(
                    new QueryStream(this.getSQLWithMetadata(sql, tags)),
                );
                const rows: any[] = [];
                let fields: QueryResult<any>['fields'] = [];
                // release the client when the stream is finished
                stream.on('end', () => {
                    done();
                    resolve({
                        rows,
                        fields: this.convertQueryResultFields(fields),
                    });
                });
                stream.on('error', (err2) => {
                    reject(err2);
                    done();
                });
                stream
                    .pipe(
                        new Writable({
                            objectMode: true,
                            write(
                                chunk: {
                                    row: any;
                                    fields: QueryResult<any>['fields'];
                                },
                                encoding,
                                callback,
                            ) {
                                rows.push(chunk.row);
                                fields = chunk.fields;
                                callback();
                            },
                        }),
                    )
                    .on('error', (err2) => {
                        reject(err2);
                        done();
                    });
            });
        })
            .catch((e) => {
                throw new WarehouseQueryError(
                    `Error running starrocks query: ${e}`,
                );
            })
            .finally(() => {
                pool?.end().catch(() => {
                    console.info('Failed to end starrocks pool');
                });
            });
    }

    async getCatalog(
        requests: {
            database: string;
            schema: string;
            table: string;
        }[],
    ) {
        const { databases, schemas, tables } = requests.reduce<{
            databases: Set<string>;
            schemas: Set<string>;
            tables: Set<string>;
        }>(
            (acc, { database, schema, table }) => ({
                databases: acc.databases.add(`'${database}'`),
                schemas: acc.schemas.add(`'${schema}'`),
                tables: acc.tables.add(`'${table}'`),
            }),
            {
                databases: new Set(),
                schemas: new Set(),
                tables: new Set(),
            },
        );
        if (databases.size <= 0 || schemas.size <= 0 || tables.size <= 0) {
            return {};
        }
        const query = `
            SELECT table_catalog,
                   table_schema,
                   table_name,
                   column_name,
                   data_type
            FROM information_schema.columns
            WHERE table_catalog IN (${Array.from(databases)})
              AND table_schema IN (${Array.from(schemas)})
              AND table_name IN (${Array.from(tables)})
        `;

        const { rows } = await this.runQuery(query);
        const catalog = rows.reduce(
            (
                acc,
                {
                    table_catalog,
                    table_schema,
                    table_name,
                    column_name,
                    data_type,
                },
            ) => {
                const match = requests.find(
                    ({ database, schema, table }) =>
                        database === table_catalog &&
                        schema === table_schema &&
                        table === table_name,
                );
                if (match) {
                    acc[table_catalog] = acc[table_catalog] || {};
                    acc[table_catalog][table_schema] =
                        acc[table_catalog][table_schema] || {};
                    acc[table_catalog][table_schema][table_name] =
                        acc[table_catalog][table_schema][table_name] || {};
                    acc[table_catalog][table_schema][table_name][column_name] =
                        mapFieldType(data_type);
                }

                return acc;
            },
            {},
        );
        return catalog;
    }

    getFieldQuoteChar() {
        return '"';
    }

    getStringQuoteChar() {
        return "'";
    }

    getEscapeStringQuoteChar() {
        return "'";
    }

    getAdapterType(): SupportedDbtAdapter {
        return SupportedDbtAdapter.STARROCKS;
    }

    getMetricSql(sql: string, metric: Metric) {
        switch (metric.type) {
            case MetricType.PERCENTILE:
                return `PERCENTILE_CONT(${
                    (metric.percentile ?? 50) / 100
                }) WITHIN GROUP (ORDER BY ${sql})`;
            case MetricType.MEDIAN:
                return `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${sql})`;
            default:
                return super.getMetricSql(sql, metric);
        }
    }
}

// Mimics behaviour in https://github.com/brianc/node-postgres/blob/master/packages/pg-connection-string/index.js
const getSSLConfigFromMode = (mode: string): PoolConfig['ssl'] => {
    switch (mode) {
        case 'disable':
            return false;
        case 'prefer':
        case 'require':
        case 'allow':
        case 'verify-ca':
        case 'verify-full':
            return {
                ca: STARROCKS_CA_BUNDLES,
            };
        case 'no-verify':
            return { rejectUnauthorized: false, ca: STARROCKS_CA_BUNDLES };
        default:
            throw new Error(`Unknown sslmode for postgres: ${mode}`);
    }
};

export class StarrocksWarehouseClient extends StarrocksClient<CreateStarrocksCredentials> {
    constructor(credentials: CreateStarrocksCredentials) {
        const ssl = getSSLConfigFromMode(credentials.sslmode || 'prefer');
        super(credentials, {
            connectionString: `mysql://${encodeURIComponent(
                credentials.user,
            )}:${encodeURIComponent(credentials.password)}@${encodeURIComponent(
                credentials.host,
            )}:${credentials.port}`,
            ssl,
        });
    }
}
