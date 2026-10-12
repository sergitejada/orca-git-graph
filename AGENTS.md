# Instrucciones para agentes

## Proyecto

Este repositorio contiene Git Graph, un plugin de desarrollo para Orca que muestra el historial del proyecto o worktree seleccionado en la sidebar. Usa TypeScript estricto, React 19, esbuild y módulos ESM. Requiere Node.js >= 22.13 y Git en el PATH.

Lee `README.md` y `package.json` antes de cambiar el comportamiento o los comandos del proyecto. Conserva los cambios existentes del usuario; revisa `git status --short` antes de editar y no hagas reset, checkout ni limpieza de archivos ajenos a la tarea.

## Mapa del código

- `src/main.ts`: worker, eventos y actualización del panel.
- `src/focus.ts`: detección del proyecto y worktree seleccionados en Orca.
- `src/render.ts` y `src/graph-style.ts`: lectura de Git, cálculo del grafo y renderizado HTML.
- `src/panel.tsx`, `src/panel.css` y `src/client.tsx`: interfaz, estilos e hidratación.
- `src/explore.ts`, `src/branch-selector.tsx` y `src/details.tsx`: búsqueda, filtros, ramas y detalles.
- `src/stash-menu.tsx` y `src/stash-actions.ts`: interfaz y comandos de acciones sobre stashes.
- `src/host.ts`: comunicación del iframe con Orca y portapapeles.
- `src/types.ts`: tipos compartidos.
- `src/build.ts` y `src/render-cli.ts`: compilación y entrada CLI.
- `orca-plugin.json`: manifiesto, panel, comandos, eventos y capacidades.
- `test/`: pruebas con `node:test` y pruebas de navegador con Playwright.

## Reglas de implementación

- Edita los fuentes de `src/`. `main.mjs` y `render.mjs` son bundles generados: actualízalos mediante la compilación cuando cambies sus fuentes, nunca a mano.
- `panel.html` y `panel.runtime.html` son archivos del panel. No los uses como fuente para implementar cambios; evita incluir HTML generado con rutas o datos de un repositorio local en el resultado.
- Sigue el estilo existente: imports ESM, comillas simples, sin punto y coma y tipos explícitos en los contratos compartidos. Evita `any` y dependencias nuevas sin necesidad.
- Mantén separados el worker Node y el código del navegador. El iframe no tiene acceso directo a Git, al sistema de archivos ni a la red.
- Orca carga el panel con `srcdoc` y una CSP restrictiva. Los scripts y estilos deben quedar inline; no introduzcas CDN ni recursos JS/CSS externos.
- Conserva la compatibilidad entre el HTML renderizado en servidor y la hidratación React, y serializa los datos de forma segura para insertarlos en HTML.
- El repositorio mostrado debe seguir la selección de Orca. Descarta actualizaciones pendientes si cambia la selección y no escribas en el estado interno de Orca.
- Los filtros deben conservar las conexiones reales del grafo: atenúa los commits que no coinciden en lugar de alterar su topología.
- Al ejecutar Git, pasa los argumentos por separado y evita interpolar rutas, refs o nombres de rama en una shell. Las acciones sobre stashes deben identificar el stash por hash y resolver su ref actual antes de eliminarlo.
- Mantén la selección explícita de terminal para las acciones de stash y la validación de las respuestas del bridge de Orca. Declara en el manifiesto las capacidades necesarias si cambias la integración.
- Conserva los atajos de teclado, el foco, las etiquetas accesibles y el comportamiento de la sidebar estrecha al cambiar la interfaz.

## Comandos y validación

Usa el gestor de paquetes ya establecido: el repositorio incluye `pnpm-lock.yaml` y `pnpm-workspace.yaml`. Evita crear otro lockfile. El README también documenta los scripts con `npm run`.

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:browser
```

- `build` comprueba los tipos y genera los bundles. `test` recompila y ejecuta las pruebas funcionales, pero no sustituye la comprobación de tipos.
- Para cambios en lógica, ejecuta `pnpm run build` y `pnpm test`. Añade o ajusta pruebas cuando cambie un comportamiento relevante.
- Para cambios en componentes, estilos, hidratación o el bridge, ejecuta además `pnpm run test:browser` después de compilar. Usa Edge instalado; algunas pruebas permiten seleccionar otro Chromium mediante `PLAYWRIGHT_BROWSER_CHANNEL` o `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Las capturas se guardan en `test-artifacts/`.
- Para cambios solo de documentación, revisa el contenido y el diff; no es necesario recompilar.
- `node render.mjs <repo>` genera el panel para un repositorio; `node render.mjs --reset` lo vacía. Ejecútalos solo cuando la tarea necesite actualizar el panel local.
- Después de recompilar, recarga el plugin en Orca si necesitas comprobar el worker en la aplicación.

## Entrega

Mantén los cambios centrados en la tarea y actualiza el README cuando cambien requisitos, comandos o comportamiento documentado. Antes de terminar, revisa el diff y comunica qué cambió, qué comprobaciones ejecutaste y cualquier limitación real de la validación. No afirmes que una prueba pasó si no la ejecutaste.
