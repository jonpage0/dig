"""Parent-run offline patch reproduction. Usage: CLONE/.venv/bin/python this.py CLONE.
Requires the maintained patch applied to that clone; no network or uv install.
"""
import argparse
import asyncio
import contextlib
import io
import json
import logging
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, sys.argv.pop(1))
import requests
from paper_search_mcp import cli, config, ncbi
from paper_search_mcp.academic_platforms.dblp import DBLPSearcher
from paper_search_mcp.academic_platforms.zenodo import ZenodoSearcher
from paper_search_mcp.academic_platforms.semantic import SemanticSearcher
from paper_search_mcp.academic_platforms.openalex import OpenAlexSearcher
from paper_search_mcp.academic_platforms.ssrn import SSRNSearcher
from paper_search_mcp.academic_platforms.pubmed import PubMedSearcher
from paper_search_mcp.academic_platforms.pmc import PMCSearcher


def response(body, status=200):
    result = requests.Response()
    result.status_code = status
    result._content = body.encode()
    return result


class Empty:
    def search(self, *args, **kwargs):
        self.empty_result_confirmed = True
        return []


class SilentFailure:
    def search(self, *args, **kwargs):
        return []


class LoggedFailure:
    def search(self, *args, **kwargs):
        logging.getLogger(__name__).error('provider timeout')
        return []


def ncbi_worker(queue):
    def fake_get(url, **kwargs):
        queue.put((time.monotonic(), kwargs['params'].get('api_key')))
        return response('<eSearchResult><IdList/></eSearchResult>')
    with patch.object(ncbi.requests, 'get', side_effect=fake_get):
        ncbi.ncbi_get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {'db': 'pubmed'})
        ncbi.ncbi_get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi', {'db': 'pmc'})


class BridgeContracts(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.loaded = patch.object(config, '_ENV_LOADED', True)
        self.loaded.start()
    def tearDown(self):
        self.loaded.stop()
        self.env.stop()

    def test_swallowed_failure_is_not_empty_and_parallel_sources_stay_separate(self):
        with patch.dict(cli.SEARCHERS, {'empty': Empty(), 'broken': LoggedFailure(), 'silent': SilentFailure()}, clear=True):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                asyncio.run(cli.cmd_search(argparse.Namespace(query='test', max_results=1, sources='empty,broken,silent', year='2025')))
            data = json.loads(out.getvalue())
            self.assertEqual(data['source_status'], {'empty': 'empty', 'broken': 'failed', 'silent': 'partial'})
            self.assertIn('provider timeout', data['errors']['broken'])
            self.assertEqual(data['coverage']['year_not_applied_to'], ['empty', 'broken', 'silent'])

    def test_dblp_bot_wall_is_failure_but_real_empty_xml_is_empty(self):
        source = DBLPSearcher()
        with patch.object(source.session, 'get', return_value=response('<html><title>Making sure you are not a bot!</title></html>')):
            papers, errors, _ = cli._search_with_diagnostics(source, 'test', 1, {})
            self.assertFalse(papers)
            self.assertTrue(errors)
        with patch.object(source.session, 'get', return_value=response('<result><hits total="0"/></result>')):
            papers, errors, warnings = cli._search_with_diagnostics(source, 'test', 1, {})
            self.assertEqual((papers, errors, warnings), ([], [], []))

    def test_zenodo_timeout_and_error_payload_are_not_empty(self):
        source = ZenodoSearcher()
        for failed in [requests.Timeout('fixture timeout'), response('{"error":"blocked"}')]:
            with self.subTest(failure=type(failed).__name__):
                kwargs = {'side_effect': failed} if isinstance(failed, Exception) else {'return_value': failed}
                with patch.object(source.session, 'get', **kwargs):
                    papers, errors, _ = cli._search_with_diagnostics(source, 'test', 1, {})
                    self.assertFalse(papers)
                    self.assertTrue(errors)
        with patch.object(source.session, 'get', return_value=response('{"hits":{"hits":[]}}')):
            self.assertEqual(cli._search_with_diagnostics(source, 'test', 1, {}), ([], [], []))

    def test_semantic_429_and_http_200_error_are_failures_without_key_downgrade(self):
        source = SemanticSearcher()
        os.environ['SEMANTIC_SCHOLAR_API_KEY'] = 'fixture-key'
        for status, body in [(429, '{}'), (200, '{"error":"unavailable"}'), (403, '{}')]:
            with patch.object(source.session, 'get', return_value=response(body, status)) as get, patch('paper_search_mcp.academic_platforms.semantic.time.sleep'):
                papers, errors, _ = cli._search_with_diagnostics(source, 'test', 1, {})
                self.assertFalse(papers)
                self.assertTrue(errors)
                self.assertTrue(all(call.kwargs['headers'].get('x-api-key') == 'fixture-key' for call in get.call_args_list))

    def test_openalex_and_ssrn_auth_alias_and_budget_preserved_on_failure(self):
        os.environ['OPENALEX_API_KEY'] = 'fixture-bare'
        os.environ['PAPER_SEARCH_MCP_OPENALEX_API_KEY'] = ' '
        for source in [OpenAlexSearcher(), SSRNSearcher()]:
            rejected = response('{"error":"quota"}', 429)
            rejected.headers['X-RateLimit-Remaining'] = '0'
            with patch.object(source.session, 'get', return_value=rejected) as get:
                _, errors, _ = cli._search_with_diagnostics(source, 'test', 1, {})
                self.assertTrue(errors)
                self.assertEqual(source.rate_limit['remaining'], 0)
                self.assertEqual(get.call_args.kwargs['headers']['Authorization'], 'Bearer fixture-bare')
                self.assertNotIn('fixture-bare', ';'.join(errors))

    def test_openalex_backed_billing_reports_status_and_usd_per_requested_source(self):
        def search(sources, **gets):
            searchers = {'openalex': OpenAlexSearcher(), 'ssrn': SSRNSearcher(), 'empty': Empty()}
            out = io.StringIO()
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.dict(cli.SEARCHERS, searchers, clear=True))
                for name, get in gets.items():
                    stack.enter_context(patch.object(searchers[name].session, 'get', **get))
                with contextlib.redirect_stdout(out):
                    asyncio.run(cli.cmd_search(argparse.Namespace(query='test', max_results=1, sources=sources, year=None)))
            return json.loads(out.getvalue())

        charged = response('{"meta":{"cost_usd":0.001},"results":[]}')
        charged.headers['X-RateLimit-Credits-Used'] = '10'
        data = search('openalex,ssrn,empty',
                      openalex={'return_value': charged},
                      ssrn={'return_value': response('{"error":"quota"}', 429)})
        # The status is kept even though the 429 raised; credits stay a separate budget value.
        self.assertEqual(data['billing'], {
            'openalex': {'http_status': 200, 'cost_usd': 0.001},
            'ssrn': {'http_status': 429, 'cost_usd': None},
        })
        self.assertEqual(data['rate_limits']['openalex']['credits-used'], 10)
        data = search('openalex,ssrn',
                      openalex={'return_value': response('{"meta":{"cost_usd":0.002},"error":"failed"}', 500)},
                      ssrn={'return_value': response('{"meta":{"cost_usd":0.003},"error":"failed"}', 400)})
        self.assertEqual(data['billing'], {
            'openalex': {'http_status': 500, 'cost_usd': 0.002},
            'ssrn': {'http_status': 400, 'cost_usd': 0.003},
        })
        data = search('openalex,ssrn',
                      openalex={'return_value': response('{"meta":{"cost_usd":-1},"results":[]}')},
                      ssrn={'side_effect': requests.ConnectionError('fixture offline')})
        self.assertEqual(data['billing'], {
            'openalex': {'http_status': 200, 'cost_usd': None},
            'ssrn': {'http_status': None, 'cost_usd': None},
        })
        self.assertNotIn('billing', search('empty'))

    def test_ncbi_cross_process_dispatch_paced_and_key_sent(self):
        # macOS/Linux parent fixture: fork inherits mocks/env, all workers share one lock path.
        ctx = multiprocessing.get_context('fork')
        queue = ctx.Queue()
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'HOME': home, 'NCBI_API_KEY': 'fixture-ncbi'}):
            workers = [ctx.Process(target=ncbi_worker, args=(queue,)) for _ in range(3)]
            for worker in workers: worker.start()
            for worker in workers:
                worker.join(15)
                if worker.is_alive():
                    worker.terminate()
                    self.fail('NCBI fixture worker did not complete')
                self.assertEqual(worker.exitcode, 0)
            calls = sorted(queue.get(timeout=2) for _ in range(6))
            self.assertTrue(all(key == 'fixture-ncbi' for _, key in calls))
            self.assertTrue(all(b[0] - a[0] >= 0.34 for a, b in zip(calls, calls[1:])))

    def test_ncbi_http_200_error_xml_is_failure_and_no_credentials_escape(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'HOME': home, 'NCBI_API_KEY': 'fixture-ncbi'}):
            with patch.object(ncbi.requests, 'get', return_value=response('<eSearchResult><ERROR>fixture-ncbi denied</ERROR></eSearchResult>')):
                with self.assertRaisesRegex(RuntimeError, 'error payload'):
                    ncbi.ncbi_get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {})
            with patch.object(ncbi.requests, 'get', side_effect=requests.Timeout('https://example.test?api_key=fixture-ncbi')):
                with self.assertRaises(RuntimeError) as error:
                    ncbi.ncbi_get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {})
                self.assertNotIn('fixture-ncbi', str(error.exception))

    def test_ncbi_query_warning_retains_papers_and_reports_limited_coverage(self):
        search_xml = (
            '<eSearchResult><Count>245385</Count><IdList><Id>42742084</Id></IdList>'
            '<QueryTranslation>asthma[All Fields]</QueryTranslation>'
            '<ErrorList><PhraseNotFound>zqxjvkplmwtt</PhraseNotFound></ErrorList>'
            '<WarningList><OutputMessage>Quoted phrase not found</OutputMessage></WarningList>'
            '</eSearchResult>'
        )
        fixtures = [
            ('pubmed', PubMedSearcher(), ncbi.requests, '42742084',
             '<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>42742084</PMID>'
             '<Article><ArticleTitle>Asthma evidence</ArticleTitle></Article>'
             '</MedlineCitation></PubmedArticle></PubmedArticleSet>'),
            ('pmc', PMCSearcher(), None, 'PMC42742084',
             '<eSummaryResult><DocSum><Id>42742084</Id>'
             '<Item Name="Title" Type="String">Asthma evidence</Item></DocSum></eSummaryResult>'),
        ]
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'HOME': home}):
            for name, source, transport, paper_id, detail_xml in fixtures:
                with self.subTest(source=name), patch.dict(cli.SEARCHERS, {name: source}, clear=True):
                    with patch.object(transport or source.session, 'get', side_effect=[response(search_xml), response(detail_xml)]):
                        out = io.StringIO()
                        with contextlib.redirect_stdout(out):
                            asyncio.run(cli.cmd_search(argparse.Namespace(query='zqxjvkplmwtt asthma', max_results=1, sources=name, year=None)))
                    data = json.loads(out.getvalue())
                    self.assertEqual([paper['paper_id'] for paper in data['papers']], [paper_id])
                    self.assertEqual(data['source_status'], {name: 'partial'})
                    self.assertEqual(data['errors'], {})
                    warnings = '; '.join(data['warnings'][name])
                    self.assertIn('PhraseNotFound: zqxjvkplmwtt', warnings)
                    self.assertIn('OutputMessage: Quoted phrase not found', warnings)
                    self.assertIn('QueryTranslation: asthma[All Fields]', warnings)
                    self.assertIn('exact-query coverage is not confirmed', warnings)

    def test_ncbi_genuine_error_is_failed_even_with_usable_ids_and_query_warning(self):
        source = PubMedSearcher()
        payload = (
            '<eSearchResult><Count>1</Count><IdList><Id>42742084</Id></IdList>'
            '<ErrorList><PhraseNotFound>zqxjvkplmwtt</PhraseNotFound></ErrorList>'
            '<ERROR>Search backend unavailable</ERROR></eSearchResult>'
        )
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'HOME': home}):
            with patch.dict(cli.SEARCHERS, {'pubmed': source}, clear=True):
                with patch.object(ncbi.requests, 'get', return_value=response(payload)):
                    out = io.StringIO()
                    with contextlib.redirect_stdout(out):
                        asyncio.run(cli.cmd_search(argparse.Namespace(query='zqxjvkplmwtt asthma', max_results=1, sources='pubmed', year=None)))
                data = json.loads(out.getvalue())
                self.assertEqual(data['papers'], [])
                self.assertEqual(data['source_status'], {'pubmed': 'failed'})
                self.assertIn('error payload', data['errors']['pubmed'])


if __name__ == '__main__':
    unittest.main()