import { names, Tree } from '@nrwl/devkit';
import { insertImport } from '@nrwl/workspace/src/utilities/ast-utils';
import * as ts from 'typescript';
import {
  addImportToModule,
  addRoute,
} from '../../../utils/nx-devkit/ast-utils';
import { NormalizedSchema } from './normalized-schema';

export function addChildren(host: Tree, options: NormalizedSchema) {
  if (!host.exists(options.parentModule)) {
    throw new Error(`Cannot find '${options.parentModule}'`);
  }

  const moduleSource = host.read(options.parentModule, 'utf-8');
  const constName = options.standalone
    ? `${names(options.name).className.toUpperCase()}_ROUTES`
    : `${names(options.fileName).propertyName}Routes`;
  const importPath = options.importPath;
  let sourceFile = ts.createSourceFile(
    options.parentModule,
    moduleSource,
    ts.ScriptTarget.Latest,
    true
  );

  if (!options.standalone) {
    sourceFile = addImportToModule(
      host,
      sourceFile,
      options.parentModule,
      options.moduleName
    );
  }

  sourceFile = addRoute(
    host,
    options.parentModule,
    sourceFile,
    `{ path: '${names(options.fileName).fileName}', children: ${constName} }`
  );
  sourceFile = insertImport(
    host,
    sourceFile,
    options.parentModule,
    options.standalone ? constName : `${options.moduleName}, ${constName}`,
    importPath
  );
}
