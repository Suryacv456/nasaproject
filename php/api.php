<?php
// Thin PHP gateway: forwards /php/api.php?endpoint=cutouts&ra=..&dec=.. to the Python backend.
// Lets a shared PHP host serve the site while Python runs elsewhere. Set BACKEND env or edit below.
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
$backend = getenv('CHRONOSCOPE_BACKEND') ?: 'http://127.0.0.1:5000';
$allowed = ['health','targets','resolve','epochs','cutouts','spectrum','lightcurve','catalogs'];
$ep = $_GET['endpoint'] ?? '';
if (!in_array($ep, $allowed, true)) { http_response_code(400); echo json_encode(['error' => 'bad endpoint']); exit; }
$params = $_GET; unset($params['endpoint']);
$url = $backend . '/api/' . $ep . '?' . http_build_query($params);
$ctx = stream_context_create(['http' => ['timeout' => 25, 'ignore_errors' => true]]);
$body = @file_get_contents($url, false, $ctx);
if ($body === false) { http_response_code(502); echo json_encode(['error' => 'backend unreachable']); exit; }
echo $body;
