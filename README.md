# TaskManager
Gerenciador de tarefas simples, que funciona offline (PWA) e guarda tudo no navegador. A sincronização entre dispositivos é opcional, via nuvem da Vercel, e não há controle de usuários no servidor.

Possui visualização de tarefas em gráfico de Gantt dinâmico.

A lista é ordenada pela data, e a tarefa arrastada pelo punho fixa a prioridade manual naquele ponto.

Eventos recorrentes ocorrem a cada período informado: ao serem concluídos, saem da lista e voltam uma semana antes da próxima ocorrência.

## Deploy na Vercel (plano Hobby)

O app é estático; a pasta `api/` vira uma função serverless (`/api/sync`) que guarda as tarefas num **Upstash Redis** do Marketplace da Vercel (plano gratuito).

1. Importe o repositório na Vercel (sem build command, sem output directory).
2. No projeto: **Storage → Create Database → Upstash Redis** (plano Free) e conecte-o ao projeto. A integração cria `KV_REST_API_URL` e `KV_REST_API_TOKEN` sozinha.
3. Faça um novo deploy para as variáveis valerem.
4. No app: **Sincronizar → Nuvem → Gerar Nova Chave → Salvar**. Use a mesma chave nos outros dispositivos.

A chave de sincronização é a única proteção dos dados (guardamos só o hash dela no servidor): não a compartilhe. Se o banco não estiver conectado, o app segue funcionando só localmente.

Desenvolvido com auxílio do Large Language Model (LLM) Anthropic Claude.
