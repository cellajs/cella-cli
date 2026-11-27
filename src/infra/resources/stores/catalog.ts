/**
 * Every provisioner factory a `stores` kind of `cella/infra/description.yml` names, re-exported side-effect-free. Import factories from here, never from
 * `./index`: importing the index provisions the stores, which must only happen inside the Pulumi program. The managed PostgreSQL is the one
 * kind; another is a `StoreProvisioner` file beside it, with Pulumi resource names and secret ids of its own, and its export line here.
 */
export { postgresManaged } from './postgres-managed';
