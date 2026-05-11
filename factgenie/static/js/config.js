
function updateLoginAccessSummary() {
    const loginActive = $('#login_active').is(':checked');
    const browsePublic = $('#show_browse_without_login').is(':checked');
    const analyzePublic = $('#show_analyze_without_login').is(':checked');
    const summary = $('#public-access-summary');

    let message = '';
    if (!loginActive) {
        message = 'Password protection is off. Browse and Analyze are public. Raw annotator names stay hidden in logged-out Browse.';
    } else if (browsePublic && analyzePublic) {
        message = 'Password protection is on. Browse and Analyze are both public for regular users. Raw annotator names stay hidden in logged-out Browse.';
    } else if (browsePublic) {
        message = 'Password protection is on. Browse is public, but Analyze still requires login. Raw annotator names stay hidden in logged-out Browse.';
    } else if (analyzePublic) {
        message = 'Password protection is on. Analyze is public, but Browse still requires login.';
    } else {
        message = 'Password protection is on. Browse and Analyze both require login.';
    }

    summary.text(message);
}

function updateConfig() {
    const config = {
        logging: {
            flask_debug: $('#debug').is(':checked'),
            level: $('#logging_level').val(),
        },
        host_prefix: $('#host_prefix').val(),
        login: {
            active: $('#login_active').is(':checked'),
            lock_view_pages: !$('#show_browse_without_login').is(':checked'),
            show_analyze_without_login: $('#show_analyze_without_login').is(':checked'),
            username: $('#login_username').val(),
            password: $('#login_password').val()
        },
        api_keys: {
            OLLAMA_API_KEY: $('#ollama_api_key').val(),
            OPENAI_API_KEY: $('#openai_api_key').val(),
            OPENROUTER_API_KEY: $('#openrouter_api_key').val(),
            ANTHROPIC_API_KEY: $('#anthropic_api_key').val(),
            GEMINI_API_KEY: $('#gemini_api_key').val(),
            VERTEXAI_PROJECT: $('#vertexai_project').val(),
            VERTEXAI_LOCATION: $('#vertexai_location').val(),
            VERTEXAI_JSON_FULL_PATH: $('#vertexai_json_full_path').val(),
        }
    };

    $.post({
        url: `${url_prefix}/update_config`,
        contentType: 'application/json', // Specify JSON content type
        data: JSON.stringify(config),
        success: function (response) {
            alert('Configuration updated successfully');
        },
        error: function (error) {
            alert('Error updating configuration: ' + error.responseText);
        }
    });

}


$(document).ready(function () {
    updateLoginAccessSummary();

    $('#login_active, #show_browse_without_login, #show_analyze_without_login').on('change', function () {
        updateLoginAccessSummary();
    });

    $("#show_hide_password a").on('click', function (event) {
        event.preventDefault();
        if ($('#show_hide_password input').attr("type") == "text") {
            $('#show_hide_password input').attr('type', 'password');
            $('#show_hide_password i').addClass("fa-eye-slash");
            $('#show_hide_password i').removeClass("fa-eye");
        } else if ($('#show_hide_password input').attr("type") == "password") {
            $('#show_hide_password input').attr('type', 'text');
            $('#show_hide_password i').removeClass("fa-eye-slash");
            $('#show_hide_password i').addClass("fa-eye");
        }
    });
});
